import {github} from './client.js';
export const getLanguages=(owner:string,repo:string)=>github<Record<string,number>>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`);
