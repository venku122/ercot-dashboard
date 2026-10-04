"""Bounded release observations: no redirects, write methods, credentials or auth."""
import argparse
import base64
from collections import Counter
import math
import sys
import datetime
import hashlib
import json
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

READ_PATHS = {'/api/status', '/api/v1/source-health', '/api/v2/tile-catalog', '/api/v1/outlook', '/api/v1/market-geography'}


def read_url_allowed(url, *, production):
    parsed = urlsplit(url)
    try:
        if parsed.username or parsed.password or parsed.fragment or '%' in parsed.path:
            return False
        if production:
            if parsed.scheme != 'https' or parsed.hostname != 'ercot.tarazevits.io' or parsed.port not in (None, 443):
                return False
        elif parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            return False
        if parsed.path in READ_PATHS:
            return not parsed.query
        if parsed.path != '/api/series':
            return False
        query = parse_qs(parsed.query, strict_parsing=True)
        if set(query) - {'metric', 'since', 'until', 'max_points', 'tag'} or not {'metric', 'since', 'until', 'max_points'} <= set(query):
            return False
        if any(len(query[key]) != 1 for key in ('metric', 'since', 'until', 'max_points')):
            return False
        since, until, points = (int(query[key][0]) for key in ('since', 'until', 'max_points'))
        return 0 <= since <= until and until - since <= 86400 and 1 <= points <= 200
    except (ValueError, TypeError):
        return False


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('redirect_not_allowed')


RESPONSE_LIMIT = 2_000_000
CORE_SOURCE_IDS = frozenset({'supply_demand'})  # supply_demand.ts SOURCE_ID, not runner name.


def _integer(value, *, nullable=False):
    return (nullable and value is None) or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)


def _number(value, *, nullable=False):
    return (nullable and value is None) or (isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value))


def _require(condition):
    if not condition:
        raise ValueError('endpoint_schema_mismatch')


def _source_assessment(payload, now):
    _require(isinstance(payload.get('sources'), list) and isinstance(payload.get('summary'), dict) and _integer(payload.get('as_of')))
    as_of = payload['as_of']
    sources, seen, counts = [], set(), Counter()
    for item in payload['sources']:
        _require(isinstance(item, dict) and isinstance(item.get('source_id'), str) and item['source_id'] and item['source_id'] not in seen)
        seen.add(item['source_id'])
        state = item.get('state')
        _require(state in ('healthy', 'delayed', 'stale', 'failed'))
        _require(item.get('collection_state') in ('healthy', 'delayed', 'failed') and item.get('freshness_state') in ('fresh', 'delayed', 'stale', 'unknown', 'event_driven'))
        _require(_integer(item.get('expected_interval_seconds')) and item['expected_interval_seconds'] > 0 and _integer(item.get('consecutive_failures')))
        _require(item.get('availability_status') in (None, 'available', 'empty'))
        _require(_integer(item.get('publication_interval_seconds'), nullable=True))
        for key in ('last_attempt_ts', 'last_success_ts', 'source_timestamp_ts', 'data_timestamp_ts', 'collection_age_seconds', 'source_age_seconds', 'data_age_seconds'):
            _require(key in item and _integer(item[key], nullable=True))
        counts[state] += 1
        timestamp = item['data_timestamp_ts'] if item['data_timestamp_ts'] is not None else item['source_timestamp_ts']
        age = None if timestamp is None else as_of - timestamp
        success = item['last_success_ts']
        collection_age = None if success is None else as_of - success
        future = as_of > now or any(item[key] is not None and item[key] > as_of for key in ('last_attempt_ts', 'last_success_ts', 'source_timestamp_ts', 'data_timestamp_ts'))
        if future:
            observed = 'INVALID_FUTURE_TIMESTAMP'
        elif item['availability_status'] in ('empty', 'unavailable'):
            observed = 'DATA_UNAVAILABLE'
        elif state == 'failed' or item['collection_state'] == 'failed' or item['consecutive_failures'] >= 3:
            observed = 'FAILED'
        elif state == 'stale' or item['freshness_state'] == 'stale':
            observed = 'STALE'
        elif timestamp is None or success is None:
            observed = 'HEALTH_NOT_OBSERVED'
        elif state != 'healthy' or item['collection_state'] != 'healthy' or item['freshness_state'] not in ('fresh', 'event_driven') or item['consecutive_failures']:
            observed = 'DELAYED'
        elif collection_age > item['expected_interval_seconds'] * 2 or (item['freshness_state'] != 'event_driven' and age > (item.get('publication_interval_seconds') or item['expected_interval_seconds']) * 4):
            observed = 'STALE'
        else:
            observed = 'HEALTHY'
        sources.append({'source_id':item['source_id'], 'reported_state':state, 'collection_state':item['collection_state'], 'freshness_state':item['freshness_state'], 'availability_status':item['availability_status'], 'consecutive_failures':item['consecutive_failures'], 'expected_interval_seconds':item['expected_interval_seconds'], 'last_success_ts':success, 'source_timestamp_ts':item['source_timestamp_ts'], 'data_timestamp_ts':item['data_timestamp_ts'], 'data_age_seconds':age, 'collection_age_seconds':collection_age, 'reported_data_age_seconds':item['data_age_seconds'], 'assessment':observed})
    _require(all(_integer(value) for value in payload['summary'].values()) and payload['summary'] == dict(counts))
    core = [source for source in sources if source['source_id'] in CORE_SOURCE_IDS]
    missing = sorted(CORE_SOURCE_IDS - seen)
    core_state = 'HEALTH_NOT_OBSERVED' if missing else ('HEALTHY' if all(source['assessment']=='HEALTHY' for source in core) else 'DEGRADED')
    all_healthy = bool(sources) and all(source['assessment']=='HEALTHY' for source in sources)
    state = 'HEALTH_NOT_OBSERVED' if not sources else 'HEALTHY' if all_healthy else 'DEGRADED'
    return {'state':state,'core_state':core_state,'all_reported_sources_healthy':all_healthy,'as_of':as_of,'required_source_ids':sorted(CORE_SOURCE_IDS),'missing_required_source_ids':missing,'reported_counts':dict(counts),'sources':sources}


def assess_endpoint(path, payload, now):
    """Validate observed receiver shape; availability is a separate conclusion."""
    _require(isinstance(payload, dict) and 'error' not in payload)
    name = urlsplit(path).path
    if name == '/api/status':
        _require(_integer(payload.get('rows')) and isinstance(payload.get('cache'),dict) and isinstance(payload.get('cache_metrics'),dict))
        normalized = payload.get('normalized_series')
        _require(isinstance(normalized,dict) and isinstance(normalized.get('ready'),bool) and _integer(normalized.get('unassigned_rows')) and isinstance(normalized.get('blocked_tile_series'),list))
        for key in ('entries','hits','misses'):
            _require(_integer(payload['cache'].get(key)))
        ready = normalized['ready'] and normalized['unassigned_rows']==0 and not normalized['blocked_tile_series']
        return {'state':'NORMALIZATION_BLOCKED' if not ready else 'DATA_AVAILABLE' if payload['rows'] else 'DATA_UNAVAILABLE','rows':payload['rows'],'normalized_ready':ready}
    if name == '/api/v1/source-health':
        return _source_assessment(payload, now)
    if name == '/api/v2/tile-catalog':
        _require(payload.get('schema')==2 and payload.get('tile_spans')=={'1h':3600,'1d':86400} and payload.get('lod_seconds')=={'native':None,'5m':300,'15m':900,'1h':3600})
        boundary=payload.get('boundary_policy')
        _require(isinstance(boundary,dict) and boundary.get('coarse_partial_clipping') is False and boundary.get('edge_lod')=='native' and isinstance(boundary.get('rule'),str))
        _require(isinstance(payload.get('series'),list) and bool(payload['series']) and isinstance(payload.get('derived_resources'),list))
        seen=set()
        for item in payload['series']:
            _require(isinstance(item,dict) and isinstance(item.get('key'),str) and item['key'] not in seen)
            seen.add(item['key'])
            _require(all(isinstance(item.get(key),str) and item[key] for key in ('metric','unit','source','statistic_policy')) and item.get('match') in ('exact','selector','paired'))
            _require(isinstance(item.get('tags'),list) and all(isinstance(tag,str) for tag in item['tags']) and _integer(item.get('native_interval_seconds')) and item['native_interval_seconds']>0)
            _require(isinstance(item.get('supported_lods'),list) and 'native' in item['supported_lods'] and set(item['supported_lods']) <= {'native','5m','15m','1h'})
        return {'state':'CAPABILITY_OBSERVED','series_count':len(seen),'coverage_proven':False}
    if name == '/api/series':
        query=parse_qs(urlsplit(path).query)
        since, until, maximum=(int(query[key][0]) for key in ('since','until','max_points'))
        _require(payload.get('metric')==query['metric'][0] and isinstance(payload.get('points'),list) and len(payload['points'])<=maximum)
        meta=payload.get('meta')
        _require(isinstance(meta,dict) and meta.get('since')==since and meta.get('until')==until and meta.get('max_points')==maximum and meta.get('aggregation')=='average' and meta.get('rollup') is None and isinstance(meta.get('stats'),dict) and isinstance(meta.get('partial_current_bucket'),bool))
        bucket=meta.get('bucket_seconds')
        _require(_integer(bucket) and bucket == (until-since)//maximum+1)
        lower=since-bucket+1
        prior=lower-1
        for point in payload['points']:
            _require(isinstance(point,list) and len(point)==2 and _integer(point[0]) and lower<=point[0]<=until and point[0]%bucket==0 and point[0]>prior and _number(point[1]))
            prior=point[0]
        timestamp=payload['points'][-1][0] if payload['points'] else None
        age=None if timestamp is None else now-timestamp
        state='DATA_UNAVAILABLE' if timestamp is None else 'INVALID_FUTURE_TIMESTAMP' if age<0 else 'STALE' if age>1800 else 'DATA_AVAILABLE'
        return {'state':state,'point_count':len(payload['points']),'latest_timestamp':timestamp,'data_age_seconds':age,'freshness_limit_seconds':1800,'coverage_proven':False,'basis':'bounded Houston legacy pricing bucket anchors; age is conservative and does not prove native or population-wide coverage'}
    if name == '/api/v1/outlook':
        _require(payload.get('schema')==1 and isinstance(payload.get('weather_context'),dict) and isinstance(payload.get('interpretation'),dict) and payload['interpretation'].get('kind')=='dashboard_outlook' and payload['interpretation'].get('official_ercot_status') is False)
        counts={}
        for group, measure in (('forecast','demand_mw'),('adequacy','projected_headroom_mw')):
            item=payload.get(group)
            _require(isinstance(item,dict) and isinstance(item.get('rows'),list) and 'publication' in item)
            _require(len(item['rows'])<=193)
            publication=item['publication']
            _require(publication is None or (isinstance(publication,dict) and all(isinstance(publication.get(key),str) for key in ('source_id','product_id','vintage_key','declared_unit')) and _integer(publication.get('issued_at')) and _integer(publication.get('retrieved_at'))))
            _require(not item['rows'] or publication is not None)
            for row in item['rows']:
                _require(isinstance(row,dict) and _integer(row.get('target_ts')) and measure in row and _number(row[measure],nullable=True))
            counts[group]=len(item['rows'])
        _require(payload['forecast'].get('selection_policy')=='in_use_flag_true' and payload['adequacy'].get('headroom_field')=='availCapRes')
        return {'state':'DATA_AVAILABLE' if counts['forecast'] or counts['adequacy'] else 'DATA_UNAVAILABLE','rows':counts,'required_for_core_gate':False}
    if name == '/api/v1/market-geography':
        _require(payload.get('schema_version')==1 and payload.get('kind')=='market_geography_manifest' and payload.get('methodology')=='market-geography-v1' and _integer(payload.get('as_of')) and payload.get('visualization_policy')=='settlement_price_matrix_not_geographic_boundaries')
        _require(isinstance(payload.get('source_health'),list) and isinstance(payload.get('resources'),list) and isinstance(payload.get('materialization_health'),dict) and payload['materialization_health'].get('state') in ('healthy','failed','unavailable') and isinstance(payload.get('deferred'),dict))
        states={}
        for key in ('settlement_interval','lmp_snapshot','constraints'):
            item=payload.get(key)
            _require(isinstance(item,dict) and item.get('state') in ('available','partial','unavailable','unavailable_no_exact_sced','valid_empty') and isinstance(item.get('rows'),list) and _integer(item.get('target_ts'),nullable=True))
            _require(not item['rows'] or item['target_ts'] is not None)
            for row in item['rows']:
                _require(isinstance(row,dict) and _integer(row.get('target_ts')))
                if key != 'constraints':
                    _require(_number(row.get('value')) and row.get('unit')=='$/MWh')
            states[key]=item['state']
        return {'state':'DATA_UNAVAILABLE' if all(value.startswith('unavailable') for value in states.values()) else 'DATA_AVAILABLE','sections':states,'materialization_state':payload['materialization_health']['state'],'required_for_core_gate':False}
    raise ValueError('unsupported_endpoint_contract')


def _read_worker(url, production, deadline):
    """Child process does exactly one guarded GET with capped single reads."""
    if not read_url_allowed(url, production=production):
        raise ValueError('unallowlisted_read')
    remaining=deadline-time.monotonic()
    if remaining<=0:
        raise TimeoutError('absolute_deadline_exhausted')
    opener=build_opener(NoRedirect())
    with opener.open(Request(url,method='GET',headers={'Accept':'application/json'}),timeout=min(10,remaining)) as response:
        chunks, size=[],0
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0:
                raise TimeoutError('absolute_deadline_exhausted')
            if response.isclosed() and response.length in (None, 0):
                break
            sock=getattr(getattr(response.fp,'raw',None),'_sock',None)
            if sock is None:
                raise ValueError('unsupported_deadline_transport')
            sock.settimeout(remaining)
            chunk=response.read1(min(65536,RESPONSE_LIMIT+1-size))
            if not chunk:
                if response.length not in (None, 0):
                    raise ValueError('incomplete_response_body')
                break
            chunks.append(chunk); size+=len(chunk)
            if size>RESPONSE_LIMIT:
                raise ValueError('response_budget_exceeded')
        body=b''.join(chunks)
        return {'status':response.status,'body_base64':base64.b64encode(body).decode('ascii'),'etag':response.headers.get('ETag'),'cache_control':response.headers.get('Cache-Control')}


def _bounded_read(url, production, deadline):
    remaining=deadline-time.monotonic()
    if remaining<=0:
        raise TimeoutError('absolute_deadline_exhausted')
    args=[sys.executable,str(Path(__file__).resolve()),'--read-worker',url,'--worker-deadline',str(deadline)]
    if production:
        args.append('--production-read-only')
    process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        output,_=process.communicate(timeout=max(0.001,deadline-time.monotonic()))
    except subprocess.TimeoutExpired:
        process.kill(); process.communicate()
        raise TimeoutError('absolute_deadline_exhausted') from None
    result=json.loads(output)
    if 'error_class' in result:
        error=RuntimeError(result['error_class'])
        error.code=result.get('status')
        error.reason=result.get('reason','transport_failure')
        error.error_class=result['error_class']
        raise error
    return result


def observe(base, *, production, max_seconds=60):
    if not read_url_allowed(base+'/api/status', production=production):
        raise ValueError('unsafe_smoke_origin')
    if not _number(max_seconds) or not 0<max_seconds<=60:
        raise ValueError('invalid_smoke_time_budget')
    started=time.monotonic(); deadline=started+max_seconds
    try:
        candidate=subprocess.check_output(['git','rev-parse','HEAD'],text=True,timeout=min(0.25,max_seconds)).strip()
    except (subprocess.SubprocessError,OSError):
        candidate='unknown'
    now=int(time.time())
    paths=sorted(READ_PATHS)+['/api/series?'+urlencode({'metric':'ercot.pricing','since':now-21600,'until':now,'max_points':100,'tag':'ercot_region:HB_HOUSTON'})]
    checks=[]
    for path in paths:
        if time.monotonic()>=deadline:
            checks.append({'path':path,'disposition':'NOT_RUN','reason':'absolute_deadline_exhausted'})
            break
        url=base+path
        if not read_url_allowed(url,production=production):
            raise ValueError('unallowlisted_read')
        optional=urlsplit(path).path in ('/api/v1/outlook','/api/v1/market-geography')
        try:
            response=_bounded_read(url,production,min(deadline,time.monotonic()+10))
            body=base64.b64decode(response.pop('body_base64'),validate=True)
            row={'path':path,'transport_disposition':'PASS','status':response['status'],'body_sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),'etag':response['etag'],'cache_control':response['cache_control'],'optional':optional}
            try:
                payload=json.loads(body)
                row['assessment']=assess_endpoint(path,payload,int(time.time()))
                row.update({'disposition':'SCHEMA_PASS','schema_disposition':'PASS','payload':payload})
            except (ValueError,TypeError,KeyError) as error:
                row.update({'disposition':'FAIL','schema_disposition':'FAIL','reason':'endpoint_schema_mismatch','error_class':type(error).__name__})
            checks.append(row)
        except Exception as error:
            reason=getattr(error,'reason',str(error) if isinstance(error,TimeoutError) else 'transport_failure')
            checks.append({'path':path,'disposition':'FAIL','transport_disposition':'BLOCKED' if getattr(error,'code',None) in (401,403) else 'FAIL','schema_disposition':'NOT_OBSERVED','reason':reason,'error_class':getattr(error,'error_class',type(error).__name__),'status':getattr(error,'code',None)})
            break
    all_schema=len(checks)==len(paths) and all(row.get('schema_disposition')=='PASS' for row in checks)
    transport_blocked=any(row.get('transport_disposition')=='BLOCKED' for row in checks)
    schema='PASS' if all_schema else 'FAIL' if any(row.get('schema_disposition')=='FAIL' for row in checks) else 'NOT_OBSERVED'
    core_states={urlsplit(row['path']).path:row.get('assessment',{}).get('core_state') if urlsplit(row['path']).path=='/api/v1/source-health' else row.get('assessment',{}).get('state') for row in checks if not row.get('optional')}
    populated=core_states.get('/api/status')=='DATA_AVAILABLE' and core_states.get('/api/v1/source-health')=='HEALTHY' and core_states.get('/api/series')=='DATA_AVAILABLE'
    acceptance='PASS' if all_schema and populated else 'BLOCKED_TRANSPORT' if transport_blocked else 'FAIL' if schema=='FAIL' else 'NOT_PROVEN'
    return {'mode':'PUBLIC_PRODUCTION_READ_ONLY' if production else 'LOCAL_RECEIVER','candidate_sha':candidate,'observed_at_utc':datetime.datetime.now(datetime.UTC).isoformat(),'origin':base,'deployed_frontend_revision':'DEPLOYED_REVISION_UNKNOWN','receiver_revision':'unknown','collector_revision':'unknown','request_budget':len(paths),'time_budget_seconds':max_seconds,'elapsed_seconds':time.monotonic()-started,'schema_acceptance':schema,'release_acceptance':acceptance,'assessment_scope':'endpoint contracts, supply_demand source attempt and bounded Houston pricing freshness; optional absence is separate','checks':checks}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin',default='http://127.0.0.1:4303')
    parser.add_argument('--production-read-only',action='store_true',help='Explicit opt-in to bounded public GET observations')
    parser.add_argument('--output')
    parser.add_argument('--read-worker',help=argparse.SUPPRESS)
    parser.add_argument('--worker-deadline',type=float,help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.read_worker:
        try:
            if args.worker_deadline is None or not math.isfinite(args.worker_deadline) or not 0<args.worker_deadline-time.monotonic()<=60:
                raise ValueError('invalid_smoke_deadline')
            result=_read_worker(args.read_worker,args.production_read_only,args.worker_deadline)
        except Exception as error:
            result={'error_class':type(error).__name__,'status':getattr(error,'code',None),'reason':str(error) if isinstance(error,(ValueError,TimeoutError)) else 'transport_failure'}
        print(json.dumps(result)); raise SystemExit(0)
    if not args.output:
        parser.error('--output is required')
    result=observe(args.origin,production=args.production_read_only)
    output=Path(args.output); output.parent.mkdir(parents=True,exist_ok=True); output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'mode':result['mode'],'schema_acceptance':result['schema_acceptance'],'release_acceptance':result['release_acceptance'],'checks':[{k:v for k,v in row.items() if k!='payload'} for row in result['checks']]}))
    raise SystemExit(0 if result['release_acceptance']=='PASS' else 1)
