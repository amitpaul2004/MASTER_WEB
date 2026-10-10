import {github} from '../services/github/client.js';
import {getRepository} from '../services/github/githubRepositoryService.js';
import {getTree} from '../services/github/githubTreeService.js';
import {getLanguages} from '../services/github/githubLanguageService.js';
import {getCommits} from '../services/github/githubCommitService.js';
import {analyzeAI} from './aiGenerationAnalyzer.js';
import {analyzeCodeIntelligence} from './codeIntelligence.js';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import http from 'node:http';
import https from 'node:https';
import type {AnalysisFile, ProgressUpdate, RepoFile, RepoReport} from '../types.js';

const ignoredDirectories=new Set(['node_modules','.git','dist','build','coverage','vendor','.next','.turbo','.cache','out','target']);
const codeSource=/\.(?:[cm]?[jt]sx?|py|java|c|h|cc|cpp|hpp|cs|go|rs|php|rb|swift|kt|kts|scala|ex|exs|erl|hrl|lua|pl|pm|r|jl|dart|vue|svelte|astro|html|css|scss|less|sql|sh|bash|ps1|bat|cmd|tf|hcl|ipynb)$/i;
const namedConfig=/^(?:package\.json|tsconfig(?:\.[^.]+)?\.json|jsconfig\.json|pyproject\.toml|requirements\.txt|Pipfile|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile|Dockerfile|Makefile|\.editorconfig|\.eslintrc(?:\..*)?|\.prettierrc(?:\..*)?|\.github\/workflows\/[^/]+\.ya?ml)$/i;
const generatedPath=/(?:\.min\.[^.]+|\.generated\.[^.]+|\.g\.[^.]+|\.pb\.[^.]+|\.freezed\.dart|\.lock)$/i;
const lockFileNames=new Set(['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','cargo.lock','poetry.lock','pdm.lock','composer.lock','gemfile.lock']);
const maxSetting=(name:string,fallback:number,hardMax:number)=>{const value=Number(process.env[name]);return Number.isInteger(value)&&value>0?Math.min(value,hardMax):fallback;};
export const ANALYSIS_MAX_FILES=maxSetting('ANALYSIS_MAX_FILES',25,500);
export const ANALYSIS_MAX_FILE_BYTES=maxSetting('ANALYSIS_MAX_FILE_BYTES',250_000,2_000_000);
export function isIgnoredPath(path:string){return path.split('/').some(part=>ignoredDirectories.has(part.toLowerCase()));}
export function isAnalysisCandidate(path:string){return codeSource.test(path)||namedConfig.test(path);}
function filePriority(path:string){const basename=path.split('/').at(-1)??path;if(/^README/i.test(basename))return 0;if(namedConfig.test(path))return 1;return 2;}
export function selectAnalysisFiles(files:RepoFile[],maxFiles=ANALYSIS_MAX_FILES,maxFileBytes=ANALYSIS_MAX_FILE_BYTES){
 const candidates=files.filter(f=>f.type==='file'&&f.size<=maxFileBytes&&!isIgnoredPath(f.path)&&!generatedPath.test(f.path)&&!lockFileNames.has((f.path.split('/').at(-1)??f.path).toLowerCase())&&isAnalysisCandidate(f.path));
 const prioritized=candidates.filter(f=>filePriority(f.path)<2).sort((a,b)=>filePriority(a.path)-filePriority(b.path)||a.path.localeCompare(b.path));
 const configBudget=Math.min(prioritized.length,Math.max(1,Math.floor(maxFiles*.35)));const chosen=prioritized.slice(0,configBudget);
 const groups=new Map<string,RepoFile[]>();for(const f of candidates.filter(x=>filePriority(x.path)===2)){const parts=f.path.split('/'),group=parts.length>1?parts.slice(0,Math.min(parts.length-1,2)).join('/'):'<root>';const list=groups.get(group)??[];list.push(f);groups.set(group,list);}
 const queues=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,items])=>items.sort((a,b)=>a.path.localeCompare(b.path)));
 while(chosen.length<maxFiles&&queues.some(q=>q.length))for(const queue of queues){const next=queue.shift();if(next&&chosen.length<maxFiles)chosen.push(next);}
 for(const config of prioritized.slice(configBudget)){if(chosen.length>=maxFiles)break;chosen.push(config);}
 return {selected:chosen,totalCandidateFiles:candidates.length};
}
const langByExt:Record<string,string>={ts:'TypeScript',tsx:'TypeScript',js:'JavaScript',jsx:'JavaScript',py:'Python',java:'Java',go:'Go',rs:'Rust',html:'HTML',css:'CSS',scss:'SCSS'};
const cache=new Map<string,{until:number;value:unknown}>();
async function cached<T>(key:string,fn:()=>Promise<T>):Promise<T>{const c=cache.get(key);if(c&&c.until>Date.now())return c.value as T;const value=await fn();cache.set(key,{until:Date.now()+5*60_000,value});return value;}
function update(progress:(event:ProgressUpdate)=>void,stage:ProgressUpdate['stage'],status:ProgressUpdate['status'],message:string,counts?:ProgressUpdate['counts']){progress({type:'progress',mode:'github',stage,status,message,...(counts?{counts}:{})});}
function skipReason(file:RepoFile){const name=file.path.split('/').at(-1)??file.path;if(isIgnoredPath(file.path))return 'Ignored dependency, generated output, or vendored directory';if(/^(?:README(?:\..*)?|readme)$/i.test(name))return 'README retained as context, excluded from source-code evidence';if(lockFileNames.has(name.toLowerCase()))return 'Lockfile excluded from source analysis';if(generatedPath.test(file.path))return 'Generated or minified file';if(file.size>ANALYSIS_MAX_FILE_BYTES)return `File exceeds ${ANALYSIS_MAX_FILE_BYTES.toLocaleString()} byte content limit`;if(!isAnalysisCandidate(file.path))return 'Unsupported file type for source analysis';return undefined;}
export async function analyzeRepository(owner:string,repo:string,progress:(event:ProgressUpdate)=>void,websiteUrl?:string):Promise<RepoReport>{
 update(progress,'input_received','complete','GitHub repository URL validated.');update(progress,'source_connected','active','Retrieving repository metadata.');
 const r=await cached(`repo:${owner}/${repo}`,()=>getRepository(owner,repo));update(progress,'source_connected','complete','GitHub repository metadata retrieved.');
 update(progress,'structure_scanned','active','Scanning the default-branch repository tree.');
 const [rawTree,languageResult]=await Promise.all([cached(`tree:${owner}/${repo}:${r.default_branch}`,()=>getTree(owner,repo,r.default_branch)),cached(`languages:${owner}/${repo}`,()=>getLanguages(owner,repo).then(data=>({data,available:true})).catch(()=>({data:{} as Record<string,number>,available:false})))]);
 const allFiles:RepoFile[]=rawTree.tree.map(x=>({path:x.path,type:x.type==='tree'?'dir':'file',size:x.size??0,sha:x.sha,extension:x.path.includes('.')?x.path.split('.').pop()!.toLowerCase():'',language:langByExt[x.path.split('.').pop()!.toLowerCase()]}));
 const visibleFiles=allFiles.filter(x=>!isIgnoredPath(x.path));const sourceFiles=allFiles.filter(x=>x.type==='file');const selection=selectAnalysisFiles(sourceFiles);const selectedPaths=new Set(selection.selected.map(f=>f.path));
 let skipped=sourceFiles.filter(f=>skipReason(f)||isAnalysisCandidate(f.path)&&!selectedPaths.has(f.path)).length;
 update(progress,'structure_scanned','complete',rawTree.truncated?'Repository tree is truncated; discovered-file coverage is incomplete.':'Repository tree scanned.',{discovered:sourceFiles.length,eligible:selection.totalCandidateFiles,skipped});
 update(progress,'technologies_detected','active','Retrieving supported project files and language metadata.');
 const fetched=await Promise.all(selection.selected.map(async f=>{try{const res=await github<{content:string;encoding:string}>(`/repos/${owner}/${repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(r.default_branch)}`);if(res.encoding!=='base64')return {path:f.path,content:'',inaccessible:true as const,reason:'GitHub did not return readable text content'};const content=Buffer.from(res.content,'base64').toString('utf8');if(content.includes('\0'))return {path:f.path,content:'',inaccessible:true as const,reason:'The returned file content is binary'};f.lines=content.split(/\r?\n/).filter(line=>line.trim()).length;return {path:f.path,content,inaccessible:false as const,reason:''};}catch(error){const reason=error instanceof Error&&error.message.includes('rate limit')?error.message:'GitHub content request failed; file content is unavailable';return {path:f.path,content:'',inaccessible:true as const,reason};}}));
 const contents=fetched.filter(f=>!f.inaccessible);const inaccessible=new Set(fetched.filter(f=>f.inaccessible).map(f=>f.path));const inaccessibleReasons=new Map(fetched.filter(f=>f.inaccessible).map(f=>[f.path,f.reason]));skipped+=inaccessible.size;
 const joined=contents.map(x=>x.content).join('\n');const paths=visibleFiles.map(f=>f.path.toLowerCase());const tech=new Set<string>();
 if(paths.some(x=>x.endsWith('package.json'))){tech.add('Node.js');if(joined.includes('"react"'))tech.add('React');if(joined.includes('"next"'))tech.add('Next.js');if(joined.includes('"vite"'))tech.add('Vite');if(joined.includes('tailwindcss'))tech.add('Tailwind CSS');if(joined.includes('express'))tech.add('Express');}if(paths.some(x=>x.endsWith('requirements.txt')||x.endsWith('pyproject.toml')))tech.add('Python');if(paths.some(x=>x.endsWith('dockerfile')))tech.add('Docker');if(paths.some(x=>x.includes('.github/workflows/')))tech.add('GitHub Actions');
 update(progress,'technologies_detected','complete',languageResult.available?'Languages and observed project technologies detected.':'Project technologies detected; GitHub language data is unavailable.',{discovered:sourceFiles.length,eligible:selection.totalCandidateFiles,analyzed:contents.length,skipped});
 update(progress,'source_analyzed','active','Analyzing readable, sampled source files.');
 update(progress,'history_inspected','active','Retrieving default-branch commit history and detailed metadata.');const commitsResult=await cached(`commits:${owner}/${repo}:${r.default_branch}`,()=>getCommits(owner,repo,r.default_branch).then(data=>({data,available:true})).catch(()=>({data:[],available:false})));
 const commits=commitsResult.data;update(progress,'history_inspected','complete',commitsResult.available?'Retrieved commit history and available detailed statistics.':'Commit history is unavailable; history-dependent signals are excluded.',{commits:commits.length,detailedCommits:commits.filter(c=>c.additions!==null).length});
 const preSkipped=sourceFiles.filter(file=>skipReason(file)||!selectedPaths.has(file.path)).map(file=>({path:file.path,reason:skipReason(file)??'Outside the configured balanced source-file sample'}));const aiSkipped=[...preSkipped,...[...inaccessible].map(path=>({path,reason:inaccessibleReasons.get(path)??'GitHub content request failed or content was not readable',status:'inaccessible' as const}))];
 update(progress,'signals_evaluated','active','Scoring source and available commit signals.');const ai=analyzeAI({files:contents.map(({path,content})=>({path,content})),commits,totalCandidateFiles:selection.totalCandidateFiles,discoveredFiles:sourceFiles.length,detailedCommitCount:commits.filter(c=>c.additions!==null).length,historyStatus:commitsResult.available?'available':'unavailable',discoveryComplete:!rawTree.truncated,skippedFiles:aiSkipped});
 const aiResult=ai as {fileResults:{path:string;lines:number;score:number;signals:{name:string;score:number}[];evidence:string[]}[]};const aiFiles=new Map(aiResult.fileResults.map(f=>[f.path,f]));
 const analysisFiles:AnalysisFile[]=sourceFiles.map(f=>{const reason=skipReason(f);if(reason)return {path:f.path,status:'skipped',reason};if(!selectedPaths.has(f.path))return {path:f.path,status:'skipped',reason:'Outside the configured balanced source-file sample'};if(inaccessible.has(f.path))return {path:f.path,status:'inaccessible',reason:inaccessibleReasons.get(f.path)??'GitHub content request failed or content was not readable'};const result=aiFiles.get(f.path);return {path:f.path,status:'analyzed',lines:f.lines,signals:result?.signals??[],evidence:result?.evidence??[]};});
 const analyzedCount=contents.filter(f=>f.content.trim()).length;update(progress,'source_analyzed','complete','Sampled source analysis complete.',{discovered:sourceFiles.length,eligible:selection.totalCandidateFiles,analyzed:analyzedCount,skipped});
 update(progress,'signals_evaluated','complete','Explainable source and available commit signals evaluated.');update(progress,'evidence_reviewed','active','Preparing evidence coverage and limitations.');update(progress,'evidence_reviewed','complete','Coverage, unavailable metadata, and skipped-file reasons recorded.');
 const loc=contents.reduce((sum,f)=>sum+f.content.split(/\r?\n/).filter(line=>line.trim()).length,0);const contributorCounts=new Map<string,number>();commits.forEach(c=>contributorCounts.set(c.author,(contributorCounts.get(c.author)??0)+1));const contributors=[...contributorCounts].map(([login,count])=>({login,commits:count}));
 const docs=sourceFiles.some(f=>/^README/i.test(f.path));const tests=sourceFiles.some(f=>/\.(test|spec)\./i.test(f.path)||f.path.includes('__tests__'));const ci=tech.has('GitHub Actions');const healthScore=Math.round((docs?20:0)+(tests?20:0)+(ci?15:0)+(visibleFiles.length?15:0)+(commits.length?15:0)+(commits.length&&Date.now()-new Date(commits[0]?.date??0).getTime()<180*86400000?15:5));
 const repositoryCoverage={sourceMode:'github',repositoryMetadataAvailable:true,treeTruncated:rawTree.truncated,filesDiscovered:sourceFiles.length,eligibleFiles:selection.totalCandidateFiles,filesSelected:selection.selected.length,filesAnalyzed:analyzedCount,filesInaccessible:inaccessible.size,filesSkipped:sourceFiles.length-analyzedCount,commitsRetrieved:commits.length,detailedCommits:commits.filter(c=>c.additions!==null).length,commitHistoryAvailable:commitsResult.available,commitHistoryMayBeTruncated:commits.length===500,commitHistoryLimit:500,languagesAvailable:languageResult.available,analysisLimitFiles:ANALYSIS_MAX_FILES,analysisLimitFileBytes:ANALYSIS_MAX_FILE_BYTES};
 let website:Record<string,unknown>|undefined,correlation:Record<string,unknown>|undefined;if(websiteUrl){update(progress,'website_inspected','active','Inspecting the optional public website.');try{website=await analyzeWebsite(websiteUrl);const detected=website.technologies as string[];const matches=[...tech].filter(t=>detected.includes(t));correlation={score:detected.length?Math.round(matches.length/Math.max(1,Math.min(tech.size,detected.length))*100):0,matches,explanation:'Technology overlap indicates correlation but does not prove this repository is the deployed source.'};}catch(e){website={available:false,url:websiteUrl,error:friendlyWebsiteError(e)};}update(progress,'website_inspected','complete',website.available===false?'Website could not be inspected; repository analysis is complete.':'Public website evidence retrieved.');}
 const intelligence=analyzeCodeIntelligence(contents.map(f=>({path:f.path,content:f.content})));
 const report:RepoReport={sourceMode:'github',repository:{name:r.name,fullName:r.full_name,owner:r.owner.login,avatar:r.owner.avatar_url,url:r.html_url,description:r.description,private:r.private,defaultBranch:r.default_branch,createdAt:r.created_at,updatedAt:r.updated_at,stars:r.stargazers_count,forks:r.forks_count,watchers:r.watchers_count,issues:r.open_issues_count,license:r.license?.spdx_id??null,topics:r.topics,treeTruncated:rawTree.truncated,repoSizeKb:r.size},files:visibleFiles,analysisFiles,languages:languageResult.data,commits,contributors,technologies:[...tech],stats:{totalFiles:visibleFiles.filter(f=>f.type==='file').length,directories:visibleFiles.filter(f=>f.type==='dir').length,totalLines:loc,sampledFiles:contents.length,firstCommit:commits.at(-1)?.date??null,latestCommit:commits[0]?.date??null,totalCommits:commits.length,largestFiles:[...visibleFiles].sort((a,b)=>b.size-a.size).slice(0,8),averageCommitsPerWeek:commits.length?Math.round(commits.length/Math.max(1,(Date.now()-new Date(commits.at(-1)?.date??Date.now()).getTime())/604800000)*10)/10:null,commitsPerMonth:monthCounts(commits)},ai,health:{score:healthScore,method:'Internal Project Health Heuristic',signals:{readme:docs,tests,ci,sourceStructure:visibleFiles.length>0,commitHistory:commitsResult.available}},repositoryCoverage,intelligence,...(website?{website,correlation}:{})};
 update(progress,'report_generated','complete','Repository report is ready.',{discovered:sourceFiles.length,eligible:selection.totalCandidateFiles,analyzed:analyzedCount,skipped,commits:commits.length,detailedCommits:commits.filter(c=>c.additions!==null).length});return report;
}
function monthCounts(commits:{date:string}[]){const map=new Map<string,number>();commits.forEach(c=>{const m=c.date.slice(0,7);map.set(m,(map.get(m)??0)+1)});return [...map].map(([month,count])=>({month,count})).reverse();}

/** Convert raw Node.js errors into user-friendly messages. */
function friendlyWebsiteError(e:unknown):string{
 if(!(e instanceof Error))return 'Website could not be accessed.';
 if(e.name==='AbortError'||/timed?\s*out/i.test(e.message))return 'Connection timed out.';
 if(/ENOTFOUND|ESERVFAIL|EAI_AGAIN|hostname could not/i.test(e.message))return 'Hostname could not be resolved. Ensure the domain name is valid.';
 if(/ECONNREFUSED/i.test(e.message))return 'Connection refused by the server.';
 if(/ECONNRESET|socket hang up/i.test(e.message))return 'Connection reset unexpectedly.';
 if(/certificate|SSL|TLS|CERT_/i.test(e.message))return 'SSL/TLS certificate verification failed.';
 if(/public host|HTTP or HTTPS|standard web port|valid\. Provide/i.test(e.message))return e.message;
 if(/redirect|response exceeds|returned HTTP|unsupported content|no addresses|invalid address/i.test(e.message))return e.message;
 return e.message||'Ensure the URL is publicly accessible.';
}

/**
 * Resolve a hostname to a validated list of public IP addresses.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6. Throws on DNS failure or private addresses.
 */
async function resolvePublicAddresses(hostname:string):Promise<{address:string;family:4|6}[]>{
 const ipVersion=isIP(hostname);
 if(ipVersion===4||ipVersion===6){
  const normalized=normalizeAddress(hostname);
  if(!isPublicAddress(normalized))throw new Error('Website URL must resolve to a public host.');
  return [{address:normalized,family:(isIP(normalized) as 4|6)}];
 }
 let results:{address:string;family:number}[];
 try{
  results=await lookup(hostname,{all:true,verbatim:true});
 }catch(e){
  const msg=e instanceof Error?e.message:'';
  if(/ENOTFOUND|ESERVFAIL|EAI_AGAIN/i.test(msg))throw new Error('Website hostname could not be resolved. Check that the URL is correct.');
  throw new Error(`DNS lookup failed: ${msg||'unknown error'}`);
 }
 if(!results||results.length===0)throw new Error('Website hostname could not be resolved: DNS returned no addresses.');
 const validated:{address:string;family:4|6}[]=[];
 for(const entry of results){
  if(!entry||typeof entry.address!=='string'||!entry.address.trim()){
   throw new Error('Website could not be analyzed: DNS returned an invalid or empty address.');
  }
  const normalized=normalizeAddress(entry.address.trim());
  const resolvedFamily=(normalized!==entry.address.trim())?4:(entry.family===6?6:4) as 4|6;
  if(!isPublicAddress(normalized))throw new Error('Website URL must resolve to a public host.');
  validated.push({address:normalized,family:resolvedFamily});
 }
 return validated;
}

/**
 * Normalize an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to its plain IPv4 form.
 * All other addresses are returned unchanged.
 */
export function normalizeAddress(ip:string):string{
 if(typeof ip!=='string')return ip;
 if(ip.toLowerCase().startsWith('::ffff:')){
  const candidate=ip.slice(7);
  if(isIP(candidate)===4)return candidate;
 }
 return ip;
}

async function analyzeWebsite(input:string){
 const u=validateWebsiteUrl(input);
 const addresses=await resolvePublicAddresses(u.hostname);
 const transport=u.protocol==='https:'?https:http;
 const html=await fetchWebsiteHtml(u,transport,addresses,0);
 const title=html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.trim()??null;
 const description=html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)/i)?.[1]??null;
 const tech:string[]=[];
 if(/__next|_next\//i.test(html))tech.push('Next.js','React');
 if(/react/i.test(html)&&!tech.includes('React'))tech.push('React');
 if(/vite/i.test(html))tech.push('Vite');
 if(/tailwind/i.test(html))tech.push('Tailwind CSS');
 if(/bootstrap/i.test(html))tech.push('Bootstrap');
 return {available:true,url:u.origin+u.pathname,status:200,title,description,technologies:tech,scripts:(html.match(/<script\b/gi)??[]).length,stylesheets:(html.match(/<link[^>]+stylesheet/gi)??[]).length,responsive:/name=["']viewport["']/i.test(html),htmlBytes:Buffer.byteLength(html)};
}

/**
 * Perform HTTP(S) GET with a pinned, pre-validated IP address to prevent DNS rebinding.
 * Follows at most one redirect, re-validating the destination with full SSRF checks.
 */
function fetchWebsiteHtml(
 u:URL,
 transport:typeof http|typeof https,
 addresses:{address:string;family:4|6}[],
 redirectDepth:number
):Promise<string>{
 const primary=addresses[0];
 return new Promise<string>((resolve,reject)=>{
  const req=transport.request(u,{
   method:'GET',
   headers:{
    'User-Agent':'RepoScope/1.0 (Public Repository & Website Intelligence Analyzer)',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9',
   },
   agent:false,
   lookup:(_hostname,options,callback)=>{
    const cb=((typeof options==='function'?options:callback)??callback) as (err:Error|null,addressOrAddresses?:unknown,family?:number)=>void;
    const opts=typeof options==='object'&&options!==null?options:{};
    if(!primary?.address||typeof primary.address!=='string'){
     cb(new Error('Internal: pinned address is not available.'));
     return;
    }
    if(opts.all){
     cb(null,addresses.map(a=>({address:a.address,family:a.family})));
    }else{
     cb(null,primary.address,primary.family);
    }
   },
   ...(u.protocol==='https:'?{servername:u.hostname}:{}),
  },res=>{
   const status=res.statusCode??0;
   if(status>=300&&status<400){
    res.resume();
    if(redirectDepth>=1){reject(new Error('Website redirects are not followed beyond one hop for security.'));return;}
    const location=res.headers['location'];
    if(!location){reject(new Error('Website redirect did not include a Location header.'));return;}
    let redirectUrl:URL;
    try{redirectUrl=new URL(location,u);}catch{reject(new Error('Website redirect destination is not a valid URL.'));return;}
    let validatedRedirect:URL;
    try{validatedRedirect=validateWebsiteUrl(redirectUrl.href);}catch(e){reject(e instanceof Error?e:new Error('Website redirect destination failed validation.'));return;}
    const redirectTransport=validatedRedirect.protocol==='https:'?https:http;
    resolvePublicAddresses(validatedRedirect.hostname)
     .then(addrs=>fetchWebsiteHtml(validatedRedirect,redirectTransport,addrs,redirectDepth+1))
     .then(resolve,reject);
    return;
   }
   if(status>=400){res.resume();reject(new Error(`Website returned HTTP ${status}.`));return;}
   const contentType=res.headers['content-type']??'';
   if(contentType&&!/text\/html|application\/xhtml/i.test(contentType)){
    res.resume();
    reject(new Error(`Website returned an unsupported content type (${contentType.split(';')[0].trim()}).`));
    return;
   }
   const declaredLength=Number(res.headers['content-length']??0);
   if(declaredLength>1_000_000){res.destroy();reject(new Error('Website response exceeds the 1 MB analysis limit.'));return;}
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_000_000){res.destroy();reject(new Error('Website response exceeds the 1 MB analysis limit.'));return;}chunks.push(chunk);});
   res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
   res.on('error',reject);
  });
  req.setTimeout(8000,()=>{req.destroy(Object.assign(new Error('Website request timed out.'),{name:'AbortError'}));});
  req.on('error',(err)=>{
   if(/Invalid IP address|EINVAL/i.test(err.message)||(err as NodeJS.ErrnoException).code==='EINVAL'){
    reject(new Error('Website network address validation failed. Ensure the URL points to a publicly reachable host.'));
   }else{
    reject(err);
   }
  });
  req.end();
 });
}

export function validateWebsiteUrl(input:string){
 let u:URL;
 try{u=new URL(input);}catch{throw new Error('Website URL is not valid. Provide a full URL including https:// or http://.');}
 if(u.protocol!=='https:'&&u.protocol!=='http:')throw new Error('Website URL must use HTTP or HTTPS.');
 if(u.username||u.password)throw new Error('Website URL must use a public host on a standard web port.');
 if(u.port&&Number(u.port)!==80&&Number(u.port)!==443)throw new Error('Website URL must use a public host on a standard web port.');
 const ipVersion=isIP(u.hostname);
 if(ipVersion!==0&&!isPublicAddress(normalizeAddress(u.hostname)))throw new Error('Website URL must resolve to a public host.');
 return u;
}

export function isPublicAddress(ip:string):boolean{
 if(typeof ip!=='string'||!ip)return false;
 if(ip.includes(':')){
  const v=ip.toLowerCase();
  if(v.startsWith('::ffff:')){const candidate=ip.slice(7);return isIP(candidate)===4&&isPublicAddress(candidate);}
  if(v==='::1'||v==='::')return false;
  if(v.startsWith('::'))return false;
  if(v.startsWith('fc')||v.startsWith('fd'))return false;
  if(v.startsWith('fe8')||v.startsWith('fe9')||v.startsWith('fea')||v.startsWith('feb'))return false;
  if(v.startsWith('ff'))return false;
  if(v.startsWith('2001:db8:'))return false;
  return true;
 }
 const parts=ip.split('.');
 if(parts.length!==4)return false;
 const n=parts.map(Number);
 if(n.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
 const [a,b,c]=n;
 if(a===0)return false;
 if(a===10)return false;
 if(a===127)return false;
 if(a>=224)return false;
 if(a===100&&b>=64&&b<=127)return false;
 if(a===169&&b===254)return false;
 if(a===172&&b>=16&&b<=31)return false;
 if(a===192&&(b===0||b===168))return false;
 if(a===198&&(b===18||b===19||(b===51&&c===100)))return false;
 if(a===203&&b===0&&c===113)return false;
 return true;
}
