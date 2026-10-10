import {describe,expect,it} from 'vitest';
import {analyzeCodeIntelligence} from '../server/src/analyzers/codeIntelligence';

describe('code intelligence analysis',()=>{
 it('resolves real local imports and leaves unknown imports explicitly unresolved',()=>{
  const result=analyzeCodeIntelligence([{path:'src/main.ts',content:"import { run } from './service'; import x from './missing';"},{path:'src/service.ts',content:'export function run() {}'}]);
  expect(result.architecture.edges).toContainEqual(expect.objectContaining({source:'file:src/main.ts',target:'file:src/service.ts',type:'import',confidence:'confirmed'}));
  expect(result.architecture.edges).toContainEqual(expect.objectContaining({type:'import',confidence:'unresolved'}));
 });
 it('reports heuristic security patterns with redacted evidence and real source coordinates',()=>{
  const result=analyzeCodeIntelligence([{path:'src/config.ts',content:"const apiKey = 'super-secret-token-value';\neval(input);"}]);
  expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({title:'Possible hardcoded credential',path:'src/config.ts',line:1})]));
  expect(JSON.stringify(result.findings)).not.toContain('super-secret-token-value');
  expect(result.findings.some(f=>f.title==='Dynamic code evaluation'&&f.confidence==='pattern')).toBe(true);
 });
 it('reads declared dependencies and recognized route declarations only',()=>{
  const result=analyzeCodeIntelligence([{path:'package.json',content:'{"dependencies":{"react":"^18"}}'},{path:'server.ts',content:"app.get('/health', handler);"}]);
  expect(result.dependencies).toEqual([{name:'react',version:'^18',kind:'dependencies',manifest:'package.json'}]);
  expect(result.architecture.nodes).toContainEqual(expect.objectContaining({label:'GET /health',type:'endpoint'}));
 });
 it('handles empty source without inventing findings or relationships',()=>{
  const result=analyzeCodeIntelligence([]);
  expect(result.findings).toEqual([]);expect(result.dependencies).toEqual([]);expect(result.architecture.edges).toEqual([]);
 });
});
