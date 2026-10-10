import yauzl from 'yauzl';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {analyzeAI, type AIFileInput} from '../analyzers/aiGenerationAnalyzer.js';
import {analyzeCodeIntelligence} from '../analyzers/codeIntelligence.js';
import {ANALYSIS_MAX_FILE_BYTES, ANALYSIS_MAX_FILES, isAnalysisCandidate, isIgnoredPath, selectAnalysisFiles} from '../analyzers/projectAnalyzer.js';
import type {AnalysisFile, ProgressUpdate, RepoFile, RepoReport} from '../types.js';

const supported=/\.(?:[cm]?[jt]sx?|py|java|c|h|cc|cpp|hpp|cs|go|rs|php|rb|swift|kt|kts|scala|ex|exs|erl|hrl|lua|pl|pm|r|jl|dart|vue|svelte|astro|html|css|scss|less|sql|sh|bash|ps1|tf|hcl|json|ya?ml|toml|ini|xml|md)$/i;
const ignoredNames=new Set(['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','poetry.lock','pdm.lock','cargo.lock','composer.lock','gemfile.lock']);
const generated=/(?:\.min\.[^.]+|\.generated\.[^.]+|\.g\.[^.]+|\.pb\.[^.]+|\.freezed\.dart|\.lock)$/i;
const maxUploadBytes=setting('ZIP_MAX_UPLOAD_BYTES',3*1024*1024*1024,3*1024*1024*1024);
const maxExpandedBytes=setting('ZIP_MAX_ANALYSIS_BYTES',64*1024*1024,128*1024*1024);
const maxRatio=setting('ZIP_MAX_COMPRESSION_RATIO',200,1000);
function setting(key:string,fallback:number,hardMax:number){const value=Number(process.env[key]);return Number.isSafeInteger(value)&&value>0?Math.min(value,hardMax):fallback;}
export const zipLimits={maxUploadBytes,maxExpandedBytes,maxRatio,maxFileBytes:ANALYSIS_MAX_FILE_BYTES,maxAnalyzedFiles:ANALYSIS_MAX_FILES};
export class ZipAnalysisError extends Error { constructor(public code:string,message:string,status=400){super(message);this.name='ZipAnalysisError';this.status=status;} status:number; }
type ArchiveRecord={file:RepoFile;content?:string;dependencyContent?:string;status:'eligible'|'skipped'|'inaccessible';reason?:string};
export function safeArchivePath(name:string){if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[a-zA-Z]:/.test(name))return false;const parts=name.replace(/\/$/,'').split('/');return parts.every(part=>part!=='.'&&part!=='..'&&part.length>0);}
function reasonFor(name:string,size:number){const base=path.posix.basename(name).toLowerCase();if(isIgnoredPath(name))return 'Dependency, version-control, or build-output directory';if(ignoredNames.has(base))return 'Lockfile excluded from source analysis';if(generated.test(name))return 'Generated or minified file';if(/\.map$/i.test(name))return 'Source map excluded from source analysis';if(!supported.test(name))return 'Unsupported or non-source file type';if(/^readme(?:\.|$)/i.test(base))return 'README retained as project context, excluded from source-code signals';if(size>ANALYSIS_MAX_FILE_BYTES)return `File exceeds the ${ANALYSIS_MAX_FILE_BYTES.toLocaleString()} byte analysis limit`;if(!isAnalysisCandidate(name))return 'Not a source or recognized project configuration file';return null;}
function openArchive(filename:string,signal?:AbortSignal,onEntry?:(entries:number,files:number,directories:number)=>void):Promise<ArchiveRecord[]>{
 return new Promise((resolve,reject)=>{yauzl.open(filename,{lazyEntries:true,decodeStrings:true,strictFileNames:false,validateEntrySizes:true},(openError,zip)=>{
  if(openError||!zip)return reject(new ZipAnalysisError('invalid_zip','The ZIP archive is malformed or could not be opened.'));
  const records:ArchiveRecord[]=[];const names=new Set<string>();let finished=false,files=0,directories=0;
  const fail=(error:ZipAnalysisError)=>{if(finished)return;finished=true;zip.close();reject(error);};
  zip.on('error',(error:Error)=>fail(/invalid relative path|invalid filename/i.test(error.message)?new ZipAnalysisError('unsafe_path','The ZIP contains an unsafe file path and was rejected.'):new ZipAnalysisError('invalid_zip','The ZIP archive is malformed or could not be read.')));
  zip.on('end',()=>{if(finished)return;finished=true;if(!records.some(record=>record.file.type==='file'))return reject(new ZipAnalysisError('empty_zip','The ZIP archive contains no files.'));resolve(records);});
  zip.on('entry',(entry:yauzl.Entry)=>{
   if(signal?.aborted)return fail(new ZipAnalysisError('cancelled','ZIP analysis was cancelled.',499));
   const raw=entry.fileName;if(!safeArchivePath(raw))return fail(new ZipAnalysisError('unsafe_path','The ZIP contains an unsafe file path and was rejected.'));
   const name=raw.replace(/\/$/,'');if(!name){zip.readEntry();return;}
   if(names.has(name))return fail(new ZipAnalysisError('duplicate_path','The ZIP contains duplicate file paths and was rejected.'));names.add(name);
   const mode=entry.externalFileAttributes>>>16;if((mode&0o170000)===0o120000)return fail(new ZipAnalysisError('symlink','The ZIP contains a symbolic link and was rejected.'));
   if(raw.endsWith('/')){directories++;records.push({file:{path:name,type:'dir',size:0,sha:'',extension:''},status:'skipped',reason:'Directory entry'});if(records.length%250===0)onEntry?.(records.length,files,directories);zip.readEntry();return;}
   const file:RepoFile={path:name,type:'file',size:entry.uncompressedSize,sha:'',extension:path.posix.extname(name).slice(1).toLowerCase()};
   files++;let skip=reasonFor(name,file.size);if(!skip&&file.size>1024*1024&&(entry.compressedSize===0||file.size/entry.compressedSize>maxRatio))skip='Compression ratio exceeds the configured safety threshold';records.push({file,status:skip?'skipped':'eligible',...(skip?{reason:skip}:{})});if(records.length%250===0)onEntry?.(records.length,files,directories);zip.readEntry();
  });zip.readEntry();
 });});
}
/** Read only a bounded sample of selected entries. The ZIP reader streams each entry
 * into a small bounded buffer; discovery never decompresses or retains file bodies. */
async function readSelected(filename:string,records:ArchiveRecord[],signal:AbortSignal|undefined,budget:number){
 const wanted=new Map(records.filter(r=>r.status==='eligible'||/(?:^|\/)package-lock\.json$/i.test(r.file.path)).map(r=>[r.file.path,r]));let used=0;
 if(!wanted.size)return {contents:[] as AIFileInput[],dependencyMetadata:[] as {path:string;content:string}[],used,failed:0,budgetSkipped:0};
 return await new Promise<{contents:AIFileInput[];dependencyMetadata:{path:string;content:string}[];used:number;failed:number;budgetSkipped:number}>((resolve,reject)=>{
  yauzl.open(filename,{lazyEntries:true,decodeStrings:true,strictFileNames:false,validateEntrySizes:true},(err,zip)=>{
   if(err||!zip)return reject(new ZipAnalysisError('invalid_zip','The ZIP archive could not be reopened for bounded source analysis.'));
   const contents:AIFileInput[]=[],dependencyMetadata:{path:string;content:string}[]=[];let failed=0,budgetSkipped=0,settled=false;
   const finish=()=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);zip.close();resolve({contents,dependencyMetadata,used,failed,budgetSkipped});};
   const abort=()=>{if(settled)return;settled=true;zip.close();reject(new ZipAnalysisError('cancelled','ZIP analysis was cancelled.',499));};
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
   zip.on('error',()=>{failed++;finish();});zip.on('end',finish);
   zip.on('entry',(entry:yauzl.Entry)=>{
    const name=entry.fileName.replace(/\/$/,'');const record=wanted.get(name);if(!record){zip.readEntry();return;}
    const lock=/(?:^|\/)package-lock\.json$/i.test(name);const limit=lock?5_000_000:ANALYSIS_MAX_FILE_BYTES;
    if(entry.uncompressedSize>limit||entry.uncompressedSize>budget-used){if(!lock){record.status='skipped';record.reason=entry.uncompressedSize>limit?'File exceeds the per-file analysis limit':'Aggregate decompressed analysis budget reached';budgetSkipped++;}zip.readEntry();return;}
    zip.openReadStream(entry,(streamError,stream)=>{if(streamError||!stream){failed++;record.status='inaccessible';record.reason='Could not read archive entry';zip.readEntry();return;}
  const chunks:Buffer[]=[];let bytes=0,tooLarge=false;stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limit||bytes>budget-used){tooLarge=true;stream.destroy(new Error('analysis resource budget'));return;}chunks.push(chunk);});
     stream.on('error',()=>{if(!tooLarge){failed++;record.status='inaccessible';record.reason='Entry decompression failed';}zip.readEntry();});
     stream.on('end',()=>{if(tooLarge){record.status='skipped';record.reason='Aggregate decompressed analysis budget reached';budgetSkipped++;zip.readEntry();return;}const body=Buffer.concat(chunks);used+=body.length;if(body.includes(0)){record.status='skipped';record.reason='Binary content is excluded from source analysis';zip.readEntry();return;}try{const content=new TextDecoder('utf-8',{fatal:true}).decode(body);if(lock)dependencyMetadata.push({path:name,content});else contents.push({path:name,content});}catch{record.status='skipped';record.reason='File is not valid UTF-8 text';}zip.readEntry();});
    });
   });zip.readEntry();
  });
 });
}
function languageFor(file:RepoFile){const ext=file.extension??'';const map:Record<string,string>={ts:'TypeScript',tsx:'TypeScript',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',py:'Python',java:'Java',go:'Go',rs:'Rust',html:'HTML',css:'CSS',scss:'SCSS',json:'JSON',yaml:'YAML',yml:'YAML',toml:'TOML',md:'Markdown'};return map[ext];}
export async function analyzeZipFile(archivePath:string,filename:string,archiveBytes:number,progress:(event:ProgressUpdate)=>void,signal?:AbortSignal):Promise<RepoReport>{
 if(archiveBytes>maxUploadBytes)throw new ZipAnalysisError('upload_too_large','ZIP uploads are limited to 3 GB.',413);
 const handle=await fs.open(archivePath,'r');const signature=Buffer.alloc(4);const read=await handle.read(signature,0,4,0);await handle.close();
 if(read.bytesRead<4||!['504b0304','504b0506','504b0708'].includes(signature.toString('hex')))throw new ZipAnalysisError('invalid_zip','The uploaded file is not a valid ZIP archive.');
 progress({type:'progress',mode:'zip',stage:'input_received',status:'complete',message:'ZIP upload received and size validated.'});
 progress({type:'progress',mode:'zip',stage:'source_connected',status:'complete',message:'ZIP signature validated; the archive remains disk-backed.'});
 progress({type:'progress',mode:'zip',stage:'structure_scanned',status:'active',message:'Enumerating archive entries and validating paths.'});
 const records=await openArchive(archivePath,signal,(entries,files,directories)=>progress({type:'progress',mode:'zip',stage:'structure_scanned',status:'active',message:'Archive metadata enumeration in progress.',counts:{entries,files,directories,discovered:files}}));if(signal?.aborted)throw new ZipAnalysisError('cancelled','ZIP analysis was cancelled.',499);
 const candidateFiles=records.filter(r=>r.status==='eligible');const selection=selectAnalysisFiles(candidateFiles.map(r=>r.file));const selected=new Set(selection.selected.map(f=>f.path));
 for(const record of candidateFiles)if(!selected.has(record.file.path)){record.status='skipped';record.reason='Outside the configurable balanced analysis sample';}
 const discovered=records.filter(r=>r.file.type==='file').length;let skippedCount=records.filter(r=>r.file.type==='file'&&r.status==='skipped').length;
 const directories=records.filter(r=>r.file.type==='dir').length;progress({type:'progress',mode:'zip',stage:'structure_scanned',status:'complete',message:'Archive structure scanned.',counts:{entries:records.length,files:discovered,directories,discovered,eligible:candidateFiles.length,skipped:skippedCount}});
 progress({type:'progress',mode:'zip',stage:'technologies_detected',status:'active',message:'Reading supported source and configuration files.'});
 const sampled=candidateFiles.filter(r=>selected.has(r.file.path));
 const lockRecords=records.filter(r=>/(?:^|\/)package-lock\.json$/i.test(r.file.path)&&r.file.size<=5_000_000);
 const streamed=await readSelected(archivePath,[...sampled,...lockRecords],signal,maxExpandedBytes);
 for(const record of sampled)if(record.status==='eligible'&&!streamed.contents.some(file=>file.path===record.file.path)){record.status='skipped';record.reason??='Not read within the configured analysis resource budget';}
 const contents=streamed.contents;const picked=sampled.filter(r=>r.status==='eligible'&&contents.some(f=>f.path===r.file.path));
 skippedCount=records.filter(r=>r.file.type==='file'&&r.status==='skipped').length;
 progress({type:'progress',mode:'zip',stage:'technologies_detected',status:'complete',message:'Supported project files identified.',counts:{discovered,eligible:candidateFiles.length,skipped:skippedCount}});
 progress({type:'progress',mode:'zip',stage:'source_analyzed',status:'active',message:'Analyzing sampled source files.'});
 progress({type:'progress',mode:'zip',stage:'signals_evaluated',status:'active',message:'Evaluating deterministic source-only signals; commit signals are not applicable to ZIPs.'});const ai=analyzeAI({files:contents,commits:[],totalCandidateFiles:candidateFiles.length,discoveredFiles:discovered,historyStatus:'not_applicable',skippedFiles:records.filter(r=>r.file.type==='file'&&r.status==='skipped').map(r=>({path:r.file.path,reason:r.reason??'Excluded from analysis'}))});
 const aiFiles=new Map((ai.fileResults as {path:string;lines:number;score:number;signals:{name:string;score:number}[];evidence:string[]}[]).map(f=>[f.path,f]));
 const analysisFiles:AnalysisFile[]=records.filter(record=>record.file.type==='file').map(record=>{const result=aiFiles.get(record.file.path);if(record.status==='eligible'&&result){record.file.lines=result.lines;return {path:record.file.path,status:'analyzed',lines:result.lines,signals:result.signals,evidence:result.evidence};}return record.status==='inaccessible'?{path:record.file.path,status:'inaccessible',reason:record.reason??'Archive entry could not be read'}:{path:record.file.path,status:'skipped',reason:record.reason??'Not included in the configured analysis sample'};});
 const languageBytes:Record<string,number>={};for(const record of picked){const language=languageFor(record.file);if(language)languageBytes[language]=(languageBytes[language]??0)+record.file.size;}
 const text=contents.map(f=>f.content).join('\n');const technologies=new Set<string>();if(contents.some(f=>f.path==='package.json')){technologies.add('Node.js');if(/"react"/.test(text))technologies.add('React');if(/"next"/.test(text))technologies.add('Next.js');if(/"vite"/.test(text))technologies.add('Vite');if(/tailwindcss/.test(text))technologies.add('Tailwind CSS');}if(contents.some(f=>f.path.endsWith('requirements.txt')||f.path.endsWith('pyproject.toml')))technologies.add('Python');if(contents.some(f=>f.path.includes('.github/workflows/')))technologies.add('GitHub Actions');
 progress({type:'progress',mode:'zip',stage:'source_analyzed',status:'complete',message:'Source analysis complete.',counts:{entries:records.length,files:discovered,directories,discovered,eligible:candidateFiles.length,analyzed:picked.length,skipped:skippedCount,bytesProcessed:streamed.used}});
 const healthSignals={readme:records.some(r=>/^readme(?:\.|$)/i.test(path.posix.basename(r.file.path))),tests:records.some(r=>/\.(test|spec)\./i.test(r.file.path)||r.file.path.includes('__tests__')),ci:records.some(r=>r.file.path.includes('.github/workflows/')),sourceStructure:picked.length>0,commitHistory:false};
 const healthScore=Math.round((healthSignals.readme?20:0)+(healthSignals.tests?20:0)+(healthSignals.ci?15:0)+(healthSignals.sourceStructure?30:0));
 progress({type:'progress',mode:'zip',stage:'signals_evaluated',status:'complete',message:'Source signals evaluated; history-dependent signals were excluded.'});
 progress({type:'progress',mode:'zip',stage:'evidence_reviewed',status:'active',message:'Preparing file coverage and analysis limitations.'});progress({type:'progress',mode:'zip',stage:'evidence_reviewed',status:'complete',message:'Coverage and skipped-file reasons are attached to the report.',counts:{discovered,eligible:candidateFiles.length,analyzed:picked.length,skipped:skippedCount}});
 const archiveName=path.posix.basename(filename).replace(/\.zip$/i,'')||'uploaded-project';
 const dependencyMetadata=streamed.dependencyMetadata;const intelligence=analyzeCodeIntelligence(contents.map(f=>({path:f.path,content:f.content})),dependencyMetadata);
 const report:RepoReport={sourceMode:'zip',repository:{name:archiveName,fullName:filename,owner:'Uploaded archive',avatar:'',url:null,description:null,private:null,defaultBranch:null,createdAt:null,updatedAt:null,stars:null,forks:null,watchers:null,issues:null,license:null,topics:[],treeTruncated:false,repoSizeKb:Math.round(archiveBytes/1024)},files:records.map(r=>r.file),analysisFiles,languages:languageBytes,commits:[],contributors:[],technologies:[...technologies],stats:{totalFiles:discovered,directories:records.filter(r=>r.file.type==='dir').length,totalLines:picked.reduce((sum,f)=>sum+(contents.find(c=>c.path===f.file.path)?.content??'').split(/\r?\n/).filter(line=>line.trim()).length,0),sampledFiles:picked.length,firstCommit:null,latestCommit:null,totalCommits:null,largestFiles:records.filter(r=>r.file.type==='file').sort((a,b)=>b.file.size-a.file.size).slice(0,8).map(r=>({path:r.file.path,size:r.file.size})),averageCommitsPerWeek:null,commitsPerMonth:[]},ai,health:{score:healthScore,method:'Internal Project Health Heuristic',signals:healthSignals},repositoryCoverage:{sourceMode:'zip',repositoryMetadataAvailable:false,filesDiscovered:discovered,eligibleFiles:candidateFiles.length,filesAnalyzed:picked.length,filesSkipped:skippedCount,commitHistory:'unavailable for ZIP archive',metadata:'archive manifest only',analysisLimitFiles:ANALYSIS_MAX_FILES,analysisLimitFileBytes:ANALYSIS_MAX_FILE_BYTES,analysisBytesProcessed:streamed.used,analysisBytesLimit:maxExpandedBytes,partial:streamed.budgetSkipped>0||streamed.failed>0||picked.length<candidateFiles.length,analysisLimitations:[...(streamed.budgetSkipped?['Configured decompressed analysis byte budget reached']:[]),...(streamed.failed?['One or more selected entries could not be read']:[]),...(picked.length<candidateFiles.length?['Analysis uses a configured source-file sample']:[])]},intelligence};
 progress({type:'progress',mode:'zip',stage:'report_generated',status:'complete',message:'ZIP project report is ready.',counts:{discovered,eligible:candidateFiles.length,analyzed:picked.length,skipped:skippedCount}});return report;
}
export const uploadLimitBytes=maxUploadBytes;
export async function analyzeZipBuffer(buffer:Buffer,filename:string,progress:(event:ProgressUpdate)=>void,signal?:AbortSignal){
 const archivePath=path.join(os.tmpdir(),`reposcope-test-${randomUUID()}.zip`);
 await fs.writeFile(archivePath,buffer,{flag:'wx'});
 try{return await analyzeZipFile(archivePath,filename,buffer.length,progress,signal);}finally{await fs.rm(archivePath,{force:true});}
}
