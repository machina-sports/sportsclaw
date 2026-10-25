import {createRequire} from 'node:module';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
const proxyaddr=createRequire(import.meta.url)('proxy-addr');
describe('proxy-addr GHSA-jqcg-44mw-7w3h regression',()=>{
 for(const subnet of ['::ffff:10.0.0.0/8','::/1']){
  it(`rejects external IPv4 trust through ${subnet}`,()=>{
   const trust=proxyaddr.compile(subnet);
   assert.equal(trust('203.0.113.10',0),false);
   assert.equal(proxyaddr({socket:{remoteAddress:'203.0.113.10'},headers:{'x-forwarded-for':'198.51.100.7'}},trust),'203.0.113.10');
  });
 }
 for(const subnet of ['10.0.0.0/8','::ffff:10.0.0.0/104']){
  it(`preserves correct subnet ${subnet}`,()=>{
   const trust=proxyaddr.compile(subnet);
   assert.equal(trust('10.1.2.3',0),true);assert.equal(trust('203.0.113.10',0),false);
  });
 }
});
