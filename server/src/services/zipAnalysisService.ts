import yauzl from 'yauzl';
import path from 'node:path';
import {analyzeAI, type AIFileInput} from '../analyzers/aiGenerationAnalyzer.js';
import {ANALYSIS_MAX_FILE_BYTES, ANALYSIS_MAX_FILES, isAnalysisCandidate, isIgnoredPath, selectAnalysisFiles} from '../analyzers/projectAnalyzer.js';
import type {AnalysisFile, ProgressUpdate, RepoFile, RepoReport} from '../types.js';

const supported=/\.(?:[cm]?[jt]sx?|py|java|c|h|cc|cpp|hpp|cs|go|rs|php|rb|swift|kt|kts|scala|ex|exs|erl|hrl|lua|pl|pm|r|jl|dart|vue|svelte|astro|html|css|scss|less|sql|sh|bash|ps1|tf|hcl|json|ya?ml|toml|ini|xml|md)$/i;
const ignoredNames=new Set(['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','poetry.lock','pdm.lock','cargo.lock','composer.lock','gemfile.lock']);
const generated=/(?:\.min\.[^.]+|\.generated\.[^.]+|\.g\.[^.]+|\.pb\.[^.]+|\.freezed\.dart|\.lock)$/i;
const maxUploadBytes=setting('ZIP_MAX_UPLOAD_BYTES',25*1024*1024,100*1024*1024);
const maxEntries=setting('ZIP_MAX_ENTRIES',3000,20_000);
const maxExpandedBytes=setting('ZIP_MAX_UNCOMPRESSED_BYTES',100*1024*1024,500*1024*1024);
const maxRatio=setting('ZIP_MAX_COMPRESSION_RATIO',200,1000);
function setting(key:string,fallback:number,hardMax:number){const value=Number(process.env[key]);return Number.isSafeInteger(value)&&value>0?Math.min(value,hardMax):fallback;}
export const zipLimits={maxUploadBytes,maxEntries,maxExpandedBytes,maxRatio,maxFileBytes:ANALYSIS_MAX_FILE_BYTES,maxAnalyzedFiles:ANALYSIS_MAX_FILES};
export class ZipAnalysisError extends Error { constructor(public code:string,message:string,status=400){super(message);this.name='ZipAnalysisError';this.status=status;} status:number; }
type ArchiveRecord={file:RepoFile;content?:string;status:'eligible'|'skipped'|'inaccessible';reason?:string};
export function safeArchivePath(name:string){if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[a-zA-Z]:/.test(name))return false;const parts=name.replace(/\/$/,'').split('/');return parts.every(part=>part!=='.'&&part!=='..'&&part.length>0);}
function reasonFor(name:string,size:number){const base=path.posix.basename(name).toLowerCase();if(isIgnoredPath(name))return 'Dependency, version-control, or build-output directory';if(ignoredNames.has(base))return 'Lockfile excluded from source analysis';if(generated.test(name))return 'Generated or minified file';if(/\.map$/i.test(name))return 'Source map excluded from source analysis';if(!supported.test(name))return 'Unsupported or non-source file type';if(/^readme(?:\.|$)/i.test(base))return 'README retained as project context, excluded from source-code signals';if(size>ANALYSIS_MAX_FILE_BYTES)return `File exceeds the ${ANALYSIS_MAX_FILE_BYTES.toLocaleString()} byte analysis limit`;if(!isAnalysisCandidate(name))return 'Not a source or recognized project configuration file';return null;}
function openArchive(buffer:Buffer,signal?:AbortSignal):Promise<ArchiveRecord[]>{
 if(buffer.length<4||buffer.subarray(0,4).toString('hex')!=='504b0304'&&buffer.subarray(0,4).toString('hex')!=='504b0506'&&buffer.subarray(0,4).toString('hex')!=='504b0708')return Promise.reject(new ZipAnalysisError('invalid_zip','The uploaded file is not a valid ZIP archive.'));
 return new Promise((resolve,reject)=>{yauzl.fromBuffer(buffer,{lazyEntries:true,decodeStrings:true,strictFileNames:false,validateEntrySizes:true},(openError,zip)=>{
  if(openError||!zip)return reject(new ZipAnalysisError('invalid_zip','The ZIP archive is malformed or could not be opened.'));
  const records:ArchiveRecord[]=[];const names=new Set<string>();let count=0,totalExpanded=0,finished=false;
  const fail=(error:ZipAnalysisError)=>{if(finished)return;finished=true;zip.close();reject(error);};
  zip.on('error',(error:Error)=>fail(/invalid relative path|invalid filename/i.test(error.message)?new ZipAnalysisError('unsafe_path','The ZIP contains an unsafe file path and was rejected.'):new ZipAnalysisError('invalid_zip','The ZIP archive is malformed or could not be read.')));
  zip.on('end',()=>{if(finished)return;finished=true;if(!records.some(record=>record.file.type==='file'))return reject(new ZipAnalysisError('empty_zip','The ZIP archive contains no files.'));resolve(records);});
  zip.on('entry',(entry:yauzl.Entry)=>{
   if(signal?.aborted)return fail(new ZipAnalysisError('cancelled','ZIP analysis was cancelled.',499));
   count++;if(count>maxEntries)return fail(new ZipAnalysisError('too_many_entries',`The ZIP contains more than the ${maxEntries.toLocaleString()} file and folder limit.`));
   const raw=entry.fileName;if(!safeArchivePath(raw))return fail(new ZipAnalysisError('unsafe_path','The ZIP contains an unsafe file path and was rejected.'));
   const name=raw.replace(/\/$/,'');if(!name){zip.readEntry();return;}
   if(names.has(name))return fail(new ZipAnalysisError('duplicate_path','The ZIP contains duplicate file paths and was rejected.'));names.add(name);
   const mode=entry.externalFileAttributes>>>16;if((mode&0o170000)===0o120000)return fail(new ZipAnalysisError('symlink','The ZIP contains a symbolic link and was rejected.'));
   if(raw.endsWith('/')){records.push({file:{path:name,type:'dir',size:0,sha:'',extension:''},status:'skipped',reason:'Directory entry'});zip.readEntry();return;}
   totalExpanded+=entry.uncompressedSize;if(entry.uncompressedSize>maxExpandedBytes||totalExpanded>maxExpandedBytes)return fail(new ZipAnalysisError('archive_too_large',`The ZIP expands beyond the ${Math.round(maxExpandedBytes/1024/1024)} MB safety limit.`));
   if(entry.uncompressedSize>1024*1024&&(entry.compressedSize===0||entry.uncompressedSize/entry.compressedSize>maxRatio))return fail(new ZipAnalysisError('compression_ratio','The ZIP contains a suspiciously compressed file and was rejected.'));
   const file:RepoFile={path:name,type:'file',size:entry.uncompressedSize,sha:'',extension:path.posix.extname(name).slice(1).toLowerCase()};
   const skip=reasonFor(name,file.size);if(skip){records.push({file,status:'skipped',reason:skip});zip.readEntry();return;}
   zip.openReadStream(entry,(streamError,stream)=>{if(streamError||!stream)return fail(new ZipAnalysisError('invalid_entry','A file inside the ZIP could not be read.'));
    const chunks:Buffer[]=[];let bytes=0;stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>ANALYSIS_MAX_FILE_BYTES){stream.destroy(new Error('file limit'));return;}chunks.push(chunk);});
    stream.on('error',()=>fail(new ZipAnalysisError('invalid_entry','A file inside the ZIP could not be read safely.')));
    stream.on('end',()=>{const content=Buffer.concat(chunks);if(content.includes(0)){records.push({file,status:'skipped',reason:'Binary content is excluded from source analysis'});}else{try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(content);records.push({file,status:'eligible',content:decoded});}catch{records.push({file,status:'skipped',reason:'File is not valid UTF-8 text'});}}zip.readEntry();});
   });
  });zip.readEntry();
 });});
}
function languageFor(file:RepoFile){const ext=file.extension??'';const map:Record<string,string>={ts:'TypeScript',tsx:'TypeScript',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',py:'Python',java:'Java',go:'Go',rs:'Rust',html:'HTML',css:'CSS',scss:'SCSS',json:'JSON',yaml:'YAML',yml:'YAML',toml:'TOML',md:'Markdown'};return map[ext];}
export async function analyzeZipBuffer(buffer:Buffer,filename:string,progress:(event:ProgressUpdate)=>void,signal?:AbortSignal):Promise<RepoReport>{
 if(buffer.length>maxUploadBytes)throw new ZipAnalysisError('upload_too_large',`ZIP uploads are limited to ${Math.round(maxUploadBytes/1024/1024)} MB.`,413);
 progress({type:'progress',mode:'zip',stage:'input_received',status:'complete',message:'ZIP upload received and size validated.'});
 progress({type:'progress',mode:'zip',stage:'source_connected',status:'active',message:'Validating archive structure and paths.'});
 const records=await openArchive(buffer,signal);if(signal?.aborted)throw new ZipAnalysisError('cancelled','ZIP analysis was cancelled.',499);progress({type:'progress',mode:'zip',stage:'source_connected',status:'complete',message:'Archive validated; no files were extracted or executed.'});
 progress({type:'progress',mode:'zip',stage:'structure_scanned',status:'active',message:'Enumerating archive contents.'});
 const candidateFiles=records.filter(r=>r.status==='eligible');const selection=selectAnalysisFiles(candidateFiles.map(r=>r.file));const selected=new Set(selection.selected.map(f=>f.path));
 for(const record of candidateFiles)if(!selected.has(record.file.path)){record.status='skipped';record.reason='Outside the configurable balanced analysis sample';}
 const picked=candidateFiles.filter(r=>r.status==='eligible');const discovered=records.filter(r=>r.file.type==='file').length;const skippedCount=records.filter(r=>r.file.type==='file'&&r.status==='skipped').length;
 progress({type:'progress',mode:'zip',stage:'structure_scanned',status:'complete',message:'Archive structure scanned.',counts:{discovered,eligible:candidateFiles.length,skipped:skippedCount}});
 progress({type:'progress',mode:'zip',stage:'technologies_detected',status:'active',message:'Reading supported source and configuration files.'});
 const contents:AIFileInput[]=picked.map(r=>({path:r.file.path,content:r.content??''}));
 progress({type:'progress',mode:'zip',stage:'technologies_detected',status:'complete',message:'Supported project files identified.',counts:{discovered,eligible:candidateFiles.length,skipped:skippedCount}});
 progress({type:'progress',mode:'zip',stage:'source_analyzed',status:'active',message:'Analyzing sampled source files.'});
 progress({type:'progress',mode:'zip',stage:'signals_evaluated',status:'active',message:'Evaluating deterministic source-only signals; commit signals are not applicable to ZIPs.'});const ai=analyzeAI({files:contents,commits:[],totalCandidateFiles:candidateFiles.length,discoveredFiles:discovered,historyStatus:'not_applicable',skippedFiles:records.filter(r=>r.file.type==='file'&&r.status==='skipped').map(r=>({path:r.file.path,reason:r.reason??'Excluded from analysis'}))});
 const aiFiles=new Map((ai.fileResults as {path:string;lines:number;score:number;signals:{name:string;score:number}[];evidence:string[]}[]).map(f=>[f.path,f]));
 const analysisFiles:AnalysisFile[]=records.filter(record=>record.file.type==='file').map(record=>{const result=aiFiles.get(record.file.path);if(record.status==='eligible'&&result){record.file.lines=result.lines;return {path:record.file.path,status:'analyzed',lines:result.lines,signals:result.signals,evidence:result.evidence};}return {path:record.file.path,status:'skipped',reason:record.reason??'Not included in the configured analysis sample'};});
 const languageBytes:Record<string,number>={};for(const record of picked){const language=languageFor(record.file);if(language)languageBytes[language]=(languageBytes[language]??0)+record.file.size;}
 const text=contents.map(f=>f.content).join('\n');const technologies=new Set<string>();if(contents.some(f=>f.path==='package.json')){technologies.add('Node.js');if(/"react"/.test(text))technologies.add('React');if(/"next"/.test(text))technologies.add('Next.js');if(/"vite"/.test(text))technologies.add('Vite');if(/tailwindcss/.test(text))technologies.add('Tailwind CSS');}if(contents.some(f=>f.path.endsWith('requirements.txt')||f.path.endsWith('pyproject.toml')))technologies.add('Python');if(contents.some(f=>f.path.includes('.github/workflows/')))technologies.add('GitHub Actions');
 progress({type:'progress',mode:'zip',stage:'source_analyzed',status:'complete',message:'Source analysis complete.',counts:{discovered,eligible:candidateFiles.length,analyzed:picked.length,skipped:skippedCount}});
 const healthSignals={readme:records.some(r=>/^readme(?:\.|$)/i.test(path.posix.basename(r.file.path))),tests:records.some(r=>/\.(test|spec)\./i.test(r.file.path)||r.file.path.includes('__tests__')),ci:records.some(r=>r.file.path.includes('.github/workflows/')),sourceStructure:picked.length>0,commitHistory:false};
 const healthScore=Math.round((healthSignals.readme?20:0)+(healthSignals.tests?20:0)+(healthSignals.ci?15:0)+(healthSignals.sourceStructure?30:0));
 progress({type:'progress',mode:'zip',stage:'signals_evaluated',status:'complete',message:'Source signals evaluated; history-dependent signals were excluded.'});
 progress({type:'progress',mode:'zip',stage:'evidence_reviewed',status:'active',message:'Preparing file coverage and analysis limitations.'});progress({type:'progress',mode:'zip',stage:'evidence_reviewed',status:'complete',message:'Coverage and skipped-file reasons are attached to the report.',counts:{discovered,eligible:candidateFiles.length,analyzed:picked.length,skipped:skippedCount}});
 const archiveName=path.posix.basename(filename).replace(/\.zip$/i,'')||'uploaded-project';
 const report:RepoReport={sourceMode:'zip',repository:{name:archiveName,fullName:filename,owner:'Uploaded archive',avatar:'',url:null,description:null,private:null,defaultBranch:null,createdAt:null,updatedAt:null,stars:null,forks:null,watchers:null,issues:null,license:null,topics:[],treeTruncated:false,repoSizeKb:Math.round(buffer.length/1024)},files:records.map(r=>r.file),analysisFiles,languages:languageBytes,commits:[],contributors:[],technologies:[...technologies],stats:{totalFiles:discovered,directories:records.filter(r=>r.file.type==='dir').length,totalLines:picked.reduce((sum,f)=>sum+(f.content??'').split(/\r?\n/).filter(line=>line.trim()).length,0),sampledFiles:picked.length,firstCommit:null,latestCommit:null,totalCommits:null,largestFiles:records.filter(r=>r.file.type==='file').sort((a,b)=>b.file.size-a.file.size).slice(0,8).map(r=>({path:r.file.path,size:r.file.size})),averageCommitsPerWeek:null,commitsPerMonth:[]},ai,health:{score:healthScore,method:'Internal Project Health Heuristic',signals:healthSignals},repositoryCoverage:{sourceMode:'zip',repositoryMetadataAvailable:false,filesDiscovered:discovered,eligibleFiles:candidateFiles.length,filesAnalyzed:picked.length,filesSkipped:skippedCount,commitHistory:'unavailable for ZIP archive',metadata:'archive manifest only',analysisLimitFiles:ANALYSIS_MAX_FILES,analysisLimitFileBytes:ANALYSIS_MAX_FILE_BYTES}};
 progress({type:'progress',mode:'zip',stage:'report_generated',status:'complete',message:'ZIP project report is ready.',counts:{discovered,eligible:candidateFiles.length,analyzed:picked.length,skipped:skippedCount}});return report;
}
export const uploadLimitBytes=maxUploadBytes;
