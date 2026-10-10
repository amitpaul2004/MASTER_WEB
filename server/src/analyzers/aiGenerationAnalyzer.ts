export type AIFileInput = { path:string; content:string };
export type AICommitInput = { message:string; additions:number|null; deletions?:number|null; filesChanged?:number|null; date:string };
export type AIInput = {
  files:AIFileInput[];
  commits:AICommitInput[];
  readme?:string;
  totalCandidateFiles?:number;
  detailedCommitCount?:number;
};

type Signal = { name:string; score:number; weight:number; contribution:number; basis:string; evidence:string[] };
const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(Number.isFinite(n)?n:0)));
const humanText=(s:string)=>s.replace(/\r/g,'');
const generatedName=/(?:\.min\.[^.]+|\.generated\.[^.]+|\.g\.[^.]+|\.pb\.[^.]+|\.freezed\.dart|\.lock)$/i;
const explicitCode=/\b(?:AI|LLM|ChatGPT|Claude|Copilot|Cursor|Windsurf|Gemini|Codeium|Devin)[- ](?:generated|written|authored|created)\b|\b(?:generated|written|authored|created)\s+(?:by|with|using)\s+(?:(?:an?|the)\s+)?(?:AI|LLM|ChatGPT|Claude(?:\s+Code)?|GitHub\s+Copilot|Copilot|Cursor|Windsurf|Gemini|Codeium|Devin)\b|\bas an AI language model\b/i;
const genericCommit=/^(?:initial commit|update(?: code| files?)?|first commit|initial version|generated code|implement (?:the )?app|build (?:the )?app)$/i;
const ignoredLines=/^(?:[{}()[\],;]|import\s|export\s|from\s|#include\s|using\s+.+;?$|package\s+\w+;?)$/i;

function codeLines(content:string){return humanText(content).split('\n').map(x=>x.trim()).filter(x=>x.length>=24&&!ignoredLines.test(x)&&!/^\/\/|^\*|^#/.test(x));}
function duplicateBlockSignals(files:AIFileInput[]){
  const occurrence=new Map<string,Set<string>>();
  for(const file of files){const lines=codeLines(file.content),seen=new Set<string>();for(let i=0;i+3<lines.length;i++){const block=lines.slice(i,i+4).join('\n');if(seen.has(block))continue;seen.add(block);const owners=occurrence.get(block)??new Set<string>();owners.add(file.path);occurrence.set(block,owners);}}
  const duplicated=[...occurrence].filter(([,owners])=>owners.size>1);const total=[...occurrence].length;const ratio=total?duplicated.length/total:0;
  return {score:clamp(ratio*100),blocks:duplicated.slice(0,5).map(([block,owners])=>({files:[...owners].slice(0,5),sample:block.split('\n')[0].slice(0,120)})),totalBlocks:total};
}
function repeatedObjectShapes(files:AIFileInput[]){
  const byShape=new Map<string,Map<string,number>>();
  for(const file of files){let keys:string[]=[];let depth=0;const flush=()=>{const shape=[...new Set(keys)].sort();if(shape.length>=4){const owners=byShape.get(shape.join('|'))??new Map<string,number>();owners.set(file.path,(owners.get(file.path)??0)+1);byShape.set(shape.join('|'),owners);}keys=[];};
    for(const line of humanText(file.content).split('\n')){const trimmed=line.trim();if(!depth&&/\{\s*$/.test(trimmed)){depth=1;keys=[];const inline=trimmed.match(/\{\s*([A-Za-z_$][\w$]*)\s*:/);if(inline)keys.push(inline[1]);continue;}if(depth){const property=trimmed.match(/^([A-Za-z_$][\w$]*)\s*:/);if(property)keys.push(property[1]);const opens=(line.match(/\{/g)??[]).length,closes=(line.match(/\}/g)??[]).length;depth=Math.max(0,depth+opens-closes);if(!depth)flush();}}
    if(depth)flush();
  }
  const repeated=[...byShape].filter(([,owners])=>[...owners.values()].reduce((a,b)=>a+b,0)>1);
  const repeatedCount=repeated.reduce((sum,[,owners])=>sum+[...owners.values()].reduce((a,b)=>a+b,0)-1,0);
  return {score:clamp(repeatedCount*10),repeatedCount,files:[...new Set(repeated.flatMap(([,owners])=>[...owners.keys()]))]};
}
function sourceSignal(file:AIFileInput){
  const explicit=humanText(file.content).split('\n').map((line,i)=>({line:line.trim().replace(/^(?:\/\/|#|\*|<!--|\/\*)\s*/,'').replace(/\s*\*\/$|\s*-->$/,''),number:i+1})).filter(x=>x.line&&explicitCode.test(x.line));
  const contentLines=humanText(file.content).split('\n').filter(x=>x.trim()).length;
  return {explicit,contentLines};
}
function scoreBand(score:number){return score<=20?'Low':score<=40?'Limited':score<=60?'Moderate':score<=80?'High':'Very high';}
function confidenceBand(score:number){return score>=75?'High':score>=45?'Moderate':'Low';}

/**
 * Explainable repository signals, not authorship classification. Direct attribution
 * is separated from weak style/history signals; duplication and commit size never
 * independently imply AI authorship.
 */
export function analyzeAI(input:AIInput){
  const files=input.files.filter(f=>f.content.trim()&&!generatedName.test(f.path));
  const explicitByFile=files.map(file=>({file,...sourceSignal(file)}));
  const explicitHits=explicitByFile.flatMap(({file,explicit})=>explicit.map(hit=>({path:file.path,...hit})));
  const attributionScore=explicitHits.length?clamp(72+Math.min(23,(new Set(explicitHits.map(x=>x.path)).size-1)*8)):0;
  const duplication=duplicateBlockSignals(files);
  const duplicateCountByFile=new Map<string,number>();for(const block of duplication.blocks)for(const path of block.files)duplicateCountByFile.set(path,(duplicateCountByFile.get(path)??0)+1);
  const shapes=repeatedObjectShapes(files);
  const shapeFiles=new Set(shapes.files);
  const analyzedCommits=input.commits.filter(c=>c.additions!==null&&c.additions!==undefined);
  const totalChanges=analyzedCommits.reduce((sum,c)=>sum+Math.max(0,c.additions??0)+Math.max(0,c.deletions??0),0);
  const sortedChanges=analyzedCommits.map(c=>Math.max(0,c.additions??0)+Math.max(0,c.deletions??0)).sort((a,b)=>b-a);
  const topShare=totalChanges?sortedChanges.slice(0,Math.max(1,Math.ceil(sortedChanges.length*.1))).reduce((a,b)=>a+b,0)/totalChanges:0;
  const largeCommitCount=analyzedCommits.filter(c=>(c.additions??0)>1000).length;
  // A concentrated history is weak context only: it is common in imports, migrations and solo work.
  const commitConcentration=analyzedCommits.length>=3?clamp(Math.max(0,(topShare-.35)*100)*.55+Math.min(largeCommitCount,3)*8):0;
  const genericMessages=analyzedCommits.filter(c=>genericCommit.test(c.message.trim())).length;
  const genericCommitScore=analyzedCommits.length>=5?clamp(genericMessages/analyzedCommits.length*100):0;
  const evidenceFor=(name:string)=>{
    if(name==='Direct attribution')return explicitHits.slice(0,8).map(x=>`${x.path}:${x.number} contains an explicit AI/tool attribution marker.`);
    if(name==='Repeated cross-file blocks')return duplication.blocks.map(b=>`A 4-line block repeats in ${b.files.join(', ')}: “${b.sample}”`);
    if(name==='Repeated object schemas')return shapes.repeatedCount?[`${shapes.repeatedCount} repeated object record shape(s) appear in sampled files; data catalogs and hand-written schemas commonly repeat too.`]:[];
    if(name==='Commit concentration')return largeCommitCount?[`${largeCommitCount} detailed commit(s) added more than 1,000 lines; this is weak context and can reflect imports or migrations.`]:topShare>.65?[`The largest 10% of detailed commits account for ${Math.round(topShare*100)}% of sampled changes; this can have many non-AI causes.`]:[];
    if(name==='Generic commit messages')return genericMessages?[`${genericMessages} detailed commit message(s) match a generic template such as “update files”.`]:[];
    return [];
  };
  const definitions=[
    {name:'Direct attribution',weight:.50,score:attributionScore,basis:'Explicit AI/tool-authorship text in sampled file content; absence does not imply human authorship.'},
    {name:'Repeated cross-file blocks',weight:.15,score:duplication.score,basis:`Exact four-line code blocks repeated across files (${duplication.blocks.length} repeated blocks among ${duplication.totalBlocks} unique blocks); common syntax and generated/vendor files are filtered.`},
    {name:'Repeated object schemas',weight:.15,score:shapes.score,basis:'Repeated multi-property object shapes in source; ordinary catalog data and hand-written schemas often have this structure, so it is weak evidence.'},
    {name:'Commit concentration',weight:.12,score:commitConcentration,basis:'Concentration of additions/deletions in the detailed commit sample; imports, migrations and rebases can look the same.'},
    {name:'Generic commit messages',weight:.08,score:genericCommitScore,basis:'Share of detailed commits using a small, explicit generic-message list; this is a weak signal.'},
  ];
  const signals:Signal[]=definitions.map(d=>({name:d.name,score:clamp(d.score),weight:d.weight,contribution:Math.round(clamp(d.score)*d.weight*10)/10,basis:d.basis,evidence:evidenceFor(d.name)}));
  const score=clamp(signals.reduce((sum,s)=>sum+s.score*s.weight,0));
  const totalCandidateFiles=Math.max(input.totalCandidateFiles??files.length,files.length);
  const fileCoverage=totalCandidateFiles?Math.min(1,files.length/totalCandidateFiles):0;
  const detailedCommitCount=input.detailedCommitCount??analyzedCommits.length;
  const hasCommitData=input.commits.length>0;
  const commitCoverage=hasCommitData?Math.min(1,detailedCommitCount/input.commits.length):null;
  const availableCoverageWeight=.65+(hasCommitData?.35:0);
  const confidenceScore=clamp(((fileCoverage*.65+(commitCoverage??0)*.35)/availableCoverageWeight)*100);
  const confidenceReasons=[`${files.length} of ${totalCandidateFiles} eligible source/config files were analyzed.`,hasCommitData?`${detailedCommitCount} of ${input.commits.length} retrieved commits had detailed change statistics.`:'Commit history was unavailable, so the evidence confidence uses file coverage only.'];
  if(files.length<5)confidenceReasons.push('Few source files were available, so code-pattern signals have limited coverage.');
  const fileResults=explicitByFile.map(({file,explicit,contentLines})=>{
    const repeatedBlocks=duplicateCountByFile.get(file.path)??0;
    const repeatedShapes=shapeFiles.has(file.path)?shapes.repeatedCount:0;
    const fileSignals=[{name:'Direct attribution',score:explicit.length?90:0},{name:'Repeated cross-file blocks',score:clamp(repeatedBlocks*20)},{name:'Repeated object schemas',score:repeatedShapes?clamp(repeatedShapes*10):0}];
    const evidence=explicit.map(x=>`Line ${x.number}: explicit AI/tool attribution marker.`);
    if(repeatedBlocks)evidence.push(`${repeatedBlocks} repeated four-line block(s) also appear in another sampled file.`);
    if(repeatedShapes)evidence.push('File participates in a repeated multi-property object shape; this is common in ordinary data catalogs too.');
    if(!explicit.length)evidence.push('No explicit attribution marker found in this file; this is not evidence of human authorship.');
    return {path:file.path,lines:contentLines,score:clamp((explicit.length?90:0)*.7+Math.min(repeatedBlocks*20,100)*.15+Math.min(repeatedShapes*10,100)*.15),signals:fileSignals,evidence};
  });
  const evidence=signals.flatMap(s=>s.evidence).slice(0,16);
  if(!explicitHits.length)evidence.unshift('No explicit AI/tool attribution marker was found in the analyzed files. Absence of a marker does not establish human authorship.');
  if(!evidence.length)evidence.push('The sampled weak signals did not provide meaningful evidence either way.');
  const limitations=[
    'AI Generation Confidence is a heuristic estimate from repository artifacts, never proof of who authored source code.',
    'Coding agents often leave no attribution markers; human-written templates, repeated conventions, generated code, migrations, and bulk imports can produce similar patterns.',
    'Results depend on the sampled files and available commit metadata. Missing data lowers confidence; it is not treated as evidence for or against AI use.',
  ];
  return {score,confidenceLevel:scoreBand(score),confidence:{score:confidenceScore,level:confidenceBand(confidenceScore),reasons:confidenceReasons},signals,evidence,limitations,fileResults,coverage:{analyzedFiles:files.length,totalCandidateFiles,detailedCommits:detailedCommitCount,totalCommits:input.commits.length}};
}
