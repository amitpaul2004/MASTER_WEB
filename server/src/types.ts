export type {AnalysisMode,AnalysisStage,ProgressUpdate} from '../../shared/analysisProgress.js';
import type {AnalysisMode} from '../../shared/analysisProgress.js';
export type RepoFile = { path:string; type:'file'|'dir'; size:number; sha:string; lines?:number; language?:string; extension?:string };
export type AnalysisFile = {path:string; status:'analyzed'|'skipped'|'inaccessible'; reason?:string; lines?:number; signals?:{name:string;score:number}[]; evidence?:string[]};
export type Commit = { sha:string; shortSha:string; message:string; author:string; avatar:string|null; date:string; additions:number|null; deletions:number|null; filesChanged:number|null; category:string };
export type RepoReport = { sourceMode:AnalysisMode; repository:Record<string,unknown>; files:RepoFile[]; analysisFiles:AnalysisFile[]; languages:Record<string,number>; commits:Commit[]; contributors:unknown[]; stats:Record<string,unknown>; technologies:string[]; ai:Record<string,unknown>; health:Record<string,unknown>; repositoryCoverage:Record<string,unknown>; website?:Record<string,unknown>; correlation?:Record<string,unknown> };
