import {github} from './client.js';
export type TreeEntry={path:string;mode:string;type:'blob'|'tree'|'commit';size?:number;sha:string};
export async function getTree(owner:string,repo:string,branch:string){return github<{sha:string;tree:TreeEntry[];truncated:boolean}>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`)}
