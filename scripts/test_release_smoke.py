import unittest
from release_smoke import read_url_allowed


class ReleaseSmokeSafety(unittest.TestCase):
    def test_public_read_paths_are_explicit(self):
        self.assertTrue(read_url_allowed('https://ercot.tarazevits.io/api/status', production=True))
        self.assertTrue(read_url_allowed('https://ercot.tarazevits.io/api/v1/source-health', production=True))
        self.assertTrue(read_url_allowed('https://ercot.tarazevits.io/api/series?metric=ercot.pricing&since=1&until=2&max_points=3', production=True))

    def test_no_writes_unknown_hosts_credentials_or_ambiguous_paths(self):
        for url in ['https://ercot.tarazevits.io/ingest', 'https://ercot.tarazevits.io/api/admin', 'https://other.example/api/status', 'http://ercot.tarazevits.io/api/status', 'https://x:y@ercot.tarazevits.io/api/status', 'https://ercot.tarazevits.io/api/%73tatus', 'https://ercot.tarazevits.io/api/status?reset=1', 'https://ercot.tarazevits.io:444/api/status']:
            with self.subTest(url=url):
                self.assertFalse(read_url_allowed(url, production=True))

    def test_local_fixture_mode_rejects_remote_hosts(self):
        self.assertTrue(read_url_allowed('http://127.0.0.1:4303/api/status', production=False))
        self.assertFalse(read_url_allowed('http://192.168.1.1/api/status', production=False))

    def test_history_is_bounded_before_network(self):
        for query in ['metric=ercot.pricing', 'metric=x&since=1&until=9999999999&max_points=3', 'metric=x&since=2&until=1&max_points=3', 'metric=x&since=1&until=2&max_points=99999', 'metric=x&since=1&until=2&max_points=3&unknown=1']:
            self.assertFalse(read_url_allowed('https://ercot.tarazevits.io/api/series?'+query, production=True))

import contextlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from release_smoke import observe


def fixture(path, *, state='healthy', empty=False, future=False):
    now = int(time.time())
    if path == '/api/status':
        return {'rows': 0 if empty else 1, 'normalized_series': {'ready': True, 'unassigned_rows': 0, 'blocked_tile_series': []}, 'cache': {'entries': 0, 'hits': 0, 'misses': 0}, 'cache_metrics': {}}
    if path == '/api/v2/tile-catalog':
        return {'schema': 2, 'tile_spans': {'1h':3600,'1d':86400}, 'lod_seconds': {'native':None,'5m':300,'15m':900,'1h':3600}, 'boundary_policy': {'coarse_partial_clipping':False,'edge_lod':'native','rule':'native boundaries'}, 'series': [{'key':'frequency.system','metric':'ercot.Frequency.Current_Frequency','tags':[],'native_interval_seconds':60,'supported_lods':['native'],'unit':'Hz','statistic_policy':'gauge','source':'ercot_realtime','match':'exact','rollup':None}], 'derived_resources': []}
    if path == '/api/v1/source-health':
        source = {'source_id':'supply_demand','display_name':'Supply and Demand','state':state,'collection_state':'failed' if state == 'failed' else 'healthy','freshness_state':'stale' if state == 'stale' else 'fresh','expected_interval_seconds':300,'publication_interval_seconds':300,'publication_mode':'polling','availability_status':'available','consecutive_failures':3 if state == 'failed' else 0,'last_attempt_ts':now,'last_success_ts':now-10,'source_timestamp_ts':now+100000 if future else now-2000 if state == 'stale' else now-60,'data_timestamp_ts':now+100000 if future else now-2000 if state == 'stale' else now-60,'collection_age_seconds':10,'source_age_seconds':2000 if state == 'stale' else 60,'data_age_seconds':2000 if state == 'stale' else 60,'last_error':'source_failure' if state == 'failed' else None}
        return {'as_of':now,'sources':[] if empty else [source],'summary':{} if empty else {state:1}}
    if path == '/api/v1/outlook':
        return {'schema':1,'forecast':{'publication':None,'rows':[],'selection_policy':'in_use_flag_true','revision_reference':None,'revision_policy':'latest_issued_at_least_24h_before_current','source_health':None},'adequacy':{'publication':None,'rows':[],'headroom_field':'availCapRes','headroom_definition':'AvailCapGen minus forecasted Demand for each hour','source_health':None},'weather_context':{'state':'current_observations_only','forecast_driver_available':False,'driver':None,'source':None,'observations':[]},'interpretation':{'kind':'dashboard_outlook','official_ercot_status':False,'status':None}}
    if path == '/api/v1/market-geography':
        return {'schema_version':1,'kind':'market_geography_manifest','methodology':'market-geography-v1','as_of':now,'visualization_policy':'settlement_price_matrix_not_geographic_boundaries','attribution_status':'unavailable_without_shift_factors','attribution_policy':'coincident_constraint_not_point_price_attribution','settlement_interval':{'state':'unavailable','target_ts':None,'rows':[],'reference_prices':[],'missing':[]},'lmp_snapshot':{'state':'unavailable','target_ts':None,'rows':[],'missing':[]},'constraints':{'state':'unavailable','target_ts':None,'rows':[],'total_count':0,'truncated':False},'source_health':[],'materialization_health':{'state':'unavailable','last_success_ts':None,'consecutive_failures':None,'last_error':'never_run'},'resources':[],'deferred':{'nodal_map':'no_reviewed_node_geometry','constraint_lines':'no_reviewed_station_geometry'}}
    raise AssertionError(path)


@contextlib.contextmanager
def local_server(payloads=None, *, trickle=None, header_trickle=False, http_status=200):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            requests.append(self.path)
            parsed = urlsplit(self.path)
            if trickle is not None:
                body = b'{}  '
            elif parsed.path == '/api/series':
                qs = parse_qs(parsed.query)
                body = json.dumps({'metric':'ercot.pricing','points':[[((int(qs['until'][0])-60)//217)*217, 12.5]],'meta':{'since':int(qs['since'][0]),'until':int(qs['until'][0]),'max_points':int(qs['max_points'][0]),'bucket_seconds':217,'aggregation':'average','rollup':None,'stats':{},'partial_current_bucket':False}}).encode()
            else:
                body = json.dumps(payloads(parsed.path) if payloads else fixture(parsed.path)).encode()
            if header_trickle:
                try:
                    for byte in b'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}':
                        time.sleep(trickle)
                        self.wfile.write(bytes([byte])); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            self.send_response(http_status)
            self.send_header('Content-Type','application/json')
            if http_status==302:
                self.send_header('Location','http://127.0.0.1:'+str(self.server.server_port)+'/api/status')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            try:
                if trickle is None:
                    self.wfile.write(body)
                else:
                    for byte in body:
                        time.sleep(trickle)
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
    thread = threading.Thread(target=server.serve_forever,kwargs={'poll_interval':0.01},daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:'+str(server.server_port), requests
    finally:
        server.shutdown(); server.server_close(); thread.join(1)


class ReleaseSmokeSemanticAcceptance(unittest.TestCase):
    def test_unrelated_success_json_fails_endpoint_contract(self):
        for value in ({}, None, {'error':'upstream_failure'}):
            with self.subTest(value=value), local_server(lambda path: value) as (base, requests):
                result = observe(base, production=False, max_seconds=3)
                self.assertFalse(all(row['disposition']=='PASS' for row in result['checks']))
                self.assertEqual('FAIL', result['schema_acceptance'])
                self.assertNotEqual('PASS', result['release_acceptance'])
                self.assertLessEqual(len(requests), 6)

    def test_optional_unavailable_is_schema_valid_and_distinct_from_populated_core(self):
        with local_server() as (base, requests):
            result = observe(base, production=False, max_seconds=5)
        self.assertEqual('PASS', result['schema_acceptance'])
        self.assertEqual('PASS', result['release_acceptance'])
        self.assertEqual(6,len(requests))
        for row in result['checks']:
            if row['path'] in ('/api/v1/outlook','/api/v1/market-geography'):
                self.assertEqual('PASS',row['schema_disposition'])
                self.assertEqual('DATA_UNAVAILABLE',row['assessment']['state'])
                self.assertTrue(row['optional'])

    def test_stale_failed_future_and_unobserved_health_never_become_healthy_zero(self):
        for state, empty, future in [('stale',False,False),('failed',False,False),('healthy',True,False),('healthy',False,True)]:
            with self.subTest(state=state,empty=empty,future=future), local_server(lambda path: fixture(path,state=state,empty=empty,future=future)) as (base, _):
                result = observe(base,production=False,max_seconds=5)
            self.assertEqual('PASS',result['schema_acceptance'])
            self.assertNotEqual('PASS',result['release_acceptance'])
            health=next(row for row in result['checks'] if row['path']=='/api/v1/source-health')['assessment']
            self.assertNotEqual('HEALTHY',health['state'])
            if not empty:
                self.assertEqual(state, health['sources'][0]['reported_state'])
                self.assertNotEqual(0,health['sources'][0]['data_age_seconds'])

    def test_old_healthy_snapshot_is_stale_at_current_observation(self):
        def old_health(path):
            payload = fixture(path)
            if path == '/api/v1/source-health':
                payload['as_of'] -= 86400
                for source in payload['sources']:
                    for field in ('last_attempt_ts', 'last_success_ts', 'source_timestamp_ts', 'data_timestamp_ts'):
                        source[field] -= 86400
            return payload
        with local_server(old_health) as (base, _):
            result = observe(base, production=False, max_seconds=5)
        health = next(row for row in result['checks'] if row['path']=='/api/v1/source-health')['assessment']
        self.assertEqual('PASS', result['schema_acceptance'])
        self.assertNotEqual('PASS', result['release_acceptance'])
        self.assertEqual('DEGRADED', health['core_state'])
        self.assertGreaterEqual(health['sources'][0]['data_age_seconds'], 86400)
        self.assertGreaterEqual(health['sources'][0]['collection_age_seconds'], 86400)

    def test_real_regular_trickle_stops_at_absolute_campaign_deadline(self):
        with local_server(trickle=0.35) as (base, requests):
            started=time.monotonic()
            result=observe(base,production=False,max_seconds=1)
            elapsed=time.monotonic()-started
            self.assertLess(elapsed,1.2)
            self.assertEqual(1,len(requests))
            self.assertNotEqual('PASS',result['release_acceptance'])
            self.assertIn('deadline',result['checks'][0].get('reason',''))

    def test_real_header_trickle_and_http_denial_are_bounded_and_distinct(self):
        with local_server(trickle=0.05,header_trickle=True) as (base, requests):
            started=time.monotonic()
            result=observe(base,production=False,max_seconds=0.4)
            self.assertLess(time.monotonic()-started,0.6)
            self.assertEqual(1,len(requests))
            self.assertIn('deadline',result['checks'][0]['reason'])
        with local_server(http_status=403) as (base, requests):
            result=observe(base,production=False,max_seconds=2)
            self.assertEqual(1,len(requests))
            self.assertEqual('BLOCKED_TRANSPORT',result['release_acceptance'])
            self.assertEqual('NOT_OBSERVED',result['schema_acceptance'])
            self.assertEqual(403,result['checks'][0]['status'])

    def test_shape_only_empty_core_is_not_populated_release_acceptance(self):
        with local_server(lambda path: fixture(path,empty=True)) as (base, requests):
            result=observe(base,production=False,max_seconds=5)
        self.assertEqual('PASS',result['schema_acceptance'])
        self.assertEqual('NOT_PROVEN',result['release_acceptance'])
        health=next(row for row in result['checks'] if row['path']=='/api/v1/source-health')['assessment']
        self.assertEqual('HEALTH_NOT_OBSERVED',health['state'])
        self.assertEqual(['supply_demand'],health['missing_required_source_ids'])

    def test_redirect_and_response_size_budget_do_not_follow_or_accept(self):
        with local_server(http_status=302) as (base, requests):
            result=observe(base,production=False,max_seconds=2)
            self.assertEqual(1,len(requests))
            self.assertEqual('redirect_not_allowed',result['checks'][0]['reason'])
            self.assertNotEqual('PASS',result['release_acceptance'])
        with local_server(lambda path: {'padding':'x'*2_000_000}) as (base, requests):
            result=observe(base,production=False,max_seconds=3)
            self.assertEqual(1,len(requests))
            self.assertEqual('response_budget_exceeded',result['checks'][0]['reason'])
            self.assertNotEqual('PASS',result['release_acceptance'])

    def test_receiver_average_boundary_anchor_is_not_a_future_native_observation(self):
        from release_smoke import assess_endpoint
        path='/api/series?metric=ercot.pricing&since=1000&until=22600&max_points=100'
        payload={'metric':'ercot.pricing','points':[[868,12.5]],'meta':{'since':1000,'until':22600,'max_points':100,'bucket_seconds':217,'aggregation':'average','rollup':None,'stats':{},'partial_current_bucket':False}}
        result=assess_endpoint(path,payload,22600)
        self.assertEqual('STALE',result['state'])
        self.assertFalse(result['coverage_proven'])
        with self.assertRaises(ValueError):
            assess_endpoint(path,{**payload,'points':[[22568+217,12.5]]},22600)

    def test_optional_failed_source_remains_explicit_while_required_core_is_healthy(self):
        def payload(path):
            result=fixture(path)
            if path=='/api/v1/source-health':
                optional=fixture(path,state='failed')['sources'][0]
                optional['source_id']='optional_fixture'
                result['sources'].append(optional)
                result['summary']['failed']=1
            return result
        with local_server(payload) as (base, _):
            result=observe(base,production=False,max_seconds=5)
        health=next(row for row in result['checks'] if row['path']=='/api/v1/source-health')['assessment']
        self.assertEqual('DEGRADED',health['state'])
        self.assertEqual('HEALTHY',health['core_state'])
        self.assertFalse(health['all_reported_sources_healthy'])
        self.assertEqual({'healthy':1,'failed':1},health['reported_counts'])
        self.assertEqual('PASS',result['release_acceptance'])
