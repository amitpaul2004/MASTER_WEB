import {github} from './client.js';
type RawCommit={sha:string;commit:{message:string;author:{name:string;date:string}|null};author:{login:string;avatar_url:string}|null};
type Detail=RawCommit&{stats?:{additions:number;deletions:number};files?:unknown[]};
export async function getCommits(owner:string,repo:string,branch:string){
 const all:RawCommit[]=[];
 for(let page=1;page<=5;page++){const batch=await github<RawCommit[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`);all.push(...batch);if(batch.length<100)break;}
 const result=[] as Awaited<ReturnType<typeof normalize>>[];
 for(let start=0;start<all.length;start+=5)result.push(...await Promise.all(all.slice(start,start+5).map((c,index)=>normalize(c,start+index,owner,repo))));
 return result;
}
async function normalize(c:RawCommit,index:number,owner:string,repo:string){let d:Detail|undefined;if(index<20){try{d=await github<Detail>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${c.sha}`)}catch{/* Detail limits must not discard commit history. */}}
 const m=c.commit.message.split('\n')[0]||'(no message)'; return {sha:c.sha,shortSha:c.sha.slice(0,7),message:m,author:c.author?.login??c.commit.author?.name??'Unknown author',avatar:c.author?.avatar_url??null,date:c.commit.author?.date??'',additions:d?.stats?.additions??null,deletions:d?.stats?.deletions??null,filesChanged:d?.files?.length??null,category:classify(m)};
}
export function classify(message:string){const m=message.toLowerCase();if(/\bfeat(ure)?\b/.test(m))return'Feature';if(/\bfix(es|ed)?\b|bug/.test(m))return'Fix';if(/refactor/.test(m))return'Refactor';if(/docs|readme|documentation/.test(m))return'Documentation';if(/test/.test(m))return'Test';if(/style|format|lint/.test(m))return'Style';if(/chore|build|ci|deps|dependenc/.test(m))return'Chore';return'Other';}
