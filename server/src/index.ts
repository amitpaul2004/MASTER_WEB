import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {randomUUID} from 'node:crypto';
import {analyzeRepository} from './analyzers/projectAnalyzer.js';
import {GithubError} from './services/github/client.js';
import {parseGithubUrl} from './utils/parseGithubUrl.js';
const app=express();app.use(cors({origin:process.env.CLIENT_ORIGIN??'http://localhost:5173'}));app.use(express.json({limit:'16kb'}));
const reports=new Map<string,unknown>();
app.get('/api/health',(_req,res)=>res.json({status:'ok'}));
app.get('/api/analysis/:id', (req,res)=>{const report=reports.get(req.params.id);if(!report)return res.status(404).json({message:'Analysis not found or expired.'});res.json(report)});
app.post('/api/analyze',async(req,res)=>{
 const repoUrl=typeof req.body?.repositoryUrl==='string'?req.body.repositoryUrl.trim():'';const websiteUrl=typeof req.body?.websiteUrl==='string'?req.body.websiteUrl.trim():'';
 const parsed=parseGithubUrl(repoUrl);if(!parsed)return res.status(400).json({message:'Enter a GitHub repository URL in the format https://github.com/owner/repository.'});
 if(websiteUrl){try{const w=new URL(websiteUrl);if(!['http:','https:'].includes(w.protocol)||w.username||w.password)throw Error();}catch{return res.status(400).json({message:'Enter a valid public website URL using HTTP or HTTPS.'})}}
 res.status(200);res.set({'Content-Type':'application/x-ndjson','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.flushHeaders();
 const progress=(phase:string)=>{if(!res.writableEnded)res.write(JSON.stringify({type:'progress',phase})+'\n')};
 try{const report=await analyzeRepository(parsed.owner,parsed.repo,progress,websiteUrl||undefined);const id=randomUUID();reports.set(id,report);while(reports.size>50)reports.delete(reports.keys().next().value!);res.write(JSON.stringify({type:'result',id,report})+'\n');res.end();}
 catch(e){const message=e instanceof GithubError?e.message:e instanceof Error?e.message:'Analysis failed. Please try again.';const status=e instanceof GithubError?e.status:400;res.write(JSON.stringify({type:'error',status,message})+'\n');res.end();}
});
const port=Number(process.env.PORT??5000);app.listen(port,()=>console.log(`RepoScope API listening on ${port}`));
