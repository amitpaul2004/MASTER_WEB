export type AnalysisMode='github'|'zip';
export type AnalysisStage='input_received'|'source_connected'|'structure_scanned'|'technologies_detected'|'source_analyzed'|'history_inspected'|'website_inspected'|'signals_evaluated'|'evidence_reviewed'|'report_generated';
export type AnalysisCounts={discovered?:number;eligible?:number;analyzed?:number;skipped?:number;commits?:number;detailedCommits?:number};
export type ProgressUpdate={type:'progress';mode:AnalysisMode;stage:AnalysisStage;status:'active'|'complete';message:string;counts?:AnalysisCounts};
