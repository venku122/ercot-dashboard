"""Bounded release observations: no redirects, write methods, credentials or auth."""
import argparse
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


def observe(base, *, production, max_seconds=60):
    if not read_url_allowed(base+'/api/status', production=production):
        raise ValueError('unsafe_smoke_origin')
    started = time.monotonic()
    now = int(time.time())
    paths = sorted(READ_PATHS) + ['/api/series?'+urlencode({'metric':'ercot.pricing','since':now-21600,'until':now,'max_points':100,'tag':'ercot_region:HB_HOUSTON'})]
    checks = []
    opener = build_opener(NoRedirect())
    for path in paths:
        if time.monotonic()-started >= max_seconds:
            checks.append({'path':path,'disposition':'NOT_RUN','reason':'time_budget_exhausted'})
            break
        url = base+path
        if not read_url_allowed(url, production=production):
            raise ValueError('unallowlisted_read')
        try:
            with opener.open(Request(url, method='GET', headers={'Accept':'application/json'}), timeout=min(10, max_seconds-(time.monotonic()-started))) as response:
                body = response.read(2_000_001)
                if len(body)>2_000_000:
                    raise ValueError('response_budget_exceeded')
                payload = json.loads(body)
                checks.append({'path':path,'status':response.status,'disposition':'PASS','body_sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),'etag':response.headers.get('ETag'),'cache_control':response.headers.get('Cache-Control'),'payload':payload})
        except Exception as error:
            checks.append({'path':path,'disposition':'FAIL','error_class':type(error).__name__,'status':getattr(error, 'code', None)})
            break
    return {'mode':'PUBLIC_PRODUCTION_READ_ONLY' if production else 'LOCAL_RECEIVER', 'candidate_sha':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'observed_at_utc':datetime.datetime.now(datetime.UTC).isoformat(),'origin':base,'deployed_frontend_revision':'DEPLOYED_REVISION_UNKNOWN','receiver_revision':'unknown','collector_revision':'unknown','request_budget':len(paths),'time_budget_seconds':max_seconds,'checks':checks}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default='http://127.0.0.1:4303')
    parser.add_argument('--production-read-only',action='store_true',help='Explicit opt-in to bounded public GET observations')
    parser.add_argument('--output', required=True)
    args=parser.parse_args()
    result=observe(args.origin, production=args.production_read_only)
    output=Path(args.output); output.parent.mkdir(parents=True,exist_ok=True); output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'mode':result['mode'],'checks':[{k:v for k,v in row.items() if k!='payload'} for row in result['checks']]}))
    raise SystemExit(0 if all(row['disposition']=='PASS' for row in result['checks']) else 1)
