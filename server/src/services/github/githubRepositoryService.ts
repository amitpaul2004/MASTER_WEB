import {github} from './client.js';
export type Repository={id:number;name:string;full_name:string;owner:{login:string;avatar_url:string};description:string|null;html_url:string;private:boolean;default_branch:string;created_at:string;updated_at:string;stargazers_count:number;forks_count:number;watchers_count:number;open_issues_count:number;license:{spdx_id:string}|null;topics:string[];size:number};
export const getRepository=(owner:string,repo:string)=>github<Repository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
