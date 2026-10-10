const API='https://api.github.com';
export class GithubError extends Error { constructor(public status:number, message:string){super(message)} }
export async function github<T>(path:string):Promise<T>{
 const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScope'};
 if(process.env.GITHUB_TOKEN) headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
 const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),15000);
 try { const r=await fetch(`${API}${path}`,{headers,signal:controller.signal}); const data=await r.json().catch(()=>({}));
  if(!r.ok){ const msg=r.status===403&&r.headers.get('x-ratelimit-remaining')==='0'?'GitHub API rate limit reached. Configure a GitHub token or try again later.':r.status===403?'GitHub denied this request. Check repository access or try again later.':r.status===404?'Repository not found or it is private.':r.status===401?'GitHub authorization failed. Check the server token.':`GitHub request failed (${r.status}).`; throw new GithubError(r.status,msg); }
  return data as T;
 } catch(e){ if(e instanceof GithubError) throw e; if((e as Error).name==='AbortError') throw new GithubError(408,'GitHub API request timed out. Try again shortly.'); throw new GithubError(503,'Could not connect to GitHub. Check your network and try again.'); }
 finally{clearTimeout(timer)}
}
