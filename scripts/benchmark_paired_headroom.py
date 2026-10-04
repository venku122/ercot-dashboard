"""Measure bounded derived tiles on a synthetic year in an isolated temporary DB."""
import sys,time,json,sqlite3,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ercot-receiver'))
import server
from paired_headroom import PAIRED_SQL, CONTRIBUTORS, KEY
with tempfile.TemporaryDirectory() as directory:
 conn=sqlite3.connect(Path(directory)/'isolated.db')
 server.init_db(conn)
 start=1735689600
 count=365*288
 ids=[]
 for side,contributor in enumerate(CONTRIBUTORS):
  sid=server.resolve_series_id(conn,contributor['metric'],contributor['tags']);ids.append(sid)
  conn.executemany('INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags,series_id) VALUES(?,?,?,?,?,?,?)',((contributor['metric'],start+i*300,(1000 if side==0 else 900)+(i%(40 if side==0 else 20)),300,'gauge',server.canonical_series_tags(contributor['tags']),sid) for i in range(count)))
 conn.commit()
 server.DB_LOCAL.conn=conn
 handler=server.Handler.__new__(server.Handler)
 definition=server.TILE_CATALOG_BY_KEY[KEY]
 results={}
 for name,days in [('6h',.25),('24h',1),('7d',7),('30d',30),('90d',90),('1y',365)]:
  cache=server.Cache(60,max_entries=512)
  spans=[('1h',start+h*3600,'native') for h in range(6)] if days<1 else [('1d',start+day*86400,'1h') for day in range(int(days))]
  def run():
   buckets=paired=0
   for span,ts,lod in spans:
    key=(span,ts,lod)
    payload=cache.get(key)
    if payload is None:
     payload,deps,ranges=handler._generate_tile(definition,span,ts,lod)
     cache.set(key,payload,deps,ranges=ranges)
    buckets+=len(payload['buckets']);paired+=payload['pairing']['paired_count']
   return buckets,paired
  began=time.perf_counter();buckets,paired=run();cold=(time.perf_counter()-began)*1000
  began=time.perf_counter();run();warm=(time.perf_counter()-began)*1000
  results[name]={'cold_ms':round(cold,3),'warm_ms':round(warm,3),'response_buckets':buckets,'paired_samples':paired,'requests':len(spans)}
 plan=[row[3] for row in conn.execute('EXPLAIN QUERY PLAN '+PAIRED_SQL,(ids[0],start,start+86400,ids[1],start,start+86400))]
 print(json.dumps({'mode':'isolated_synthetic_representative_year','contributor_rows':count*2,'database_bytes':Path(directory,'isolated.db').stat().st_size,'sql_plan':plan,'windows':results},indent=2))
 conn.close();del server.DB_LOCAL.conn
