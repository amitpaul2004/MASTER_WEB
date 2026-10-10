export function parseGithubUrl(input:string){
 try{const url=new URL(input);if(url.protocol!=='https:'||url.hostname.toLowerCase()!=='github.com'||url.username||url.password)return null;const parts=url.pathname.split('/').filter(Boolean);if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_.-]+$/.test(x)))return null;const repo=parts[1].replace(/\.git$/i,'');return repo?{owner:parts[0],repo}:null;}catch{return null;}
}
