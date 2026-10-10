import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {randomUUID} from 'node:crypto';
import {analyzeRepository} from './analyzers/projectAnalyzer.js';
import {GithubError} from './services/github/client.js';
import {parseGithubUrl} from './utils/parseGithubUrl.js';
import {analyzeZipBuffer, uploadLimitBytes, zipLimits, ZipAnalysisError} from './services/zipAnalysisService.js';
import type {ProgressUpdate, RepoReport} from './types.js';

export const app=express();app.use(cors({origin:process.env.CLIENT_ORIGIN??'http://localhost:5173'}));app.use(express.json({limit:'16kb'}));
const reports=new Map<string,RepoReport>();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:uploadLimitBytes,files:1,fields:2,parts:3},fileFilter:(_req,file,cb)=>file.originalname.toLowerCase().endsWith('.zip')?cb(null,true):cb(new ZipAnalysisError('unsupported_upload','Choose a .zip archive to analyze.'))});
app.get('/api/health',(_req,res)=>res.json({status:'ok',uploadMaxBytes:uploadLimitBytes,zipLimits}));
app.get('/api/analysis/:id',(req,res)=>{const report=reports.get(req.params.id);if(!report)return res.status(404).json({message:'Analysis not found or expired.'});res.json(report)});
function startStream(res:express.Response){res.status(200).set({'Content-Type':'application/x-ndjson','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.flushHeaders();}
function progressWriter(res:express.Response){return (event:ProgressUpdate)=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(event)+'\n');};}
function storeReport(report:RepoReport){const id=randomUUID();reports.set(id,report);while(reports.size>50)reports.delete(reports.keys().next().value!);return id;}
app.post('/api/analyze',async(req,res)=>{
 const repoUrl=typeof req.body?.repositoryUrl==='string'?req.body.repositoryUrl.trim():'';const websiteUrl=typeof req.body?.websiteUrl==='string'?req.body.websiteUrl.trim():'';const parsed=parseGithubUrl(repoUrl);
 if(!parsed)return res.status(400).json({message:'Enter a GitHub repository URL in the format https://github.com/owner/repository.'});
 if(websiteUrl){try{const w=new URL(websiteUrl);if(!['http:','https:'].includes(w.protocol)||w.username||w.password)throw Error();}catch{return res.status(400).json({message:'Enter a valid public website URL using HTTP or HTTPS.'})}}
 startStream(res);const progress=progressWriter(res);
 try{const report=await analyzeRepository(parsed.owner,parsed.repo,progress,websiteUrl||undefined);const id=storeReport(report);if(!res.destroyed){res.write(JSON.stringify({type:'result',id,report})+'\n');res.end();}}
 catch(error){if(!res.destroyed){const status=error instanceof GithubError?error.status:500;const message=error instanceof GithubError?error.message:'Repository analysis failed. Check the URL and try again.';res.write(JSON.stringify({type:'error',status,message})+'\n');res.end();}}
});
app.post('/api/analyze/zip',upload.single('archive'),async(req,res)=>{
 const file=req.file;if(!file)return res.status(400).json({message:'Choose a ZIP archive before starting analysis.'});
 startStream(res);const progress=progressWriter(res);const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
 try{const report=await analyzeZipBuffer(file.buffer,file.originalname,progress,abort.signal);const id=storeReport(report);if(!res.destroyed){res.write(JSON.stringify({type:'result',id,report})+'\n');res.end();}}
 catch(error){if(!res.destroyed){const typed=error instanceof ZipAnalysisError;res.write(JSON.stringify({type:'error',status:typed?error.status:500,message:typed?error.message:'The ZIP could not be analyzed. Check the archive and try again.'})+'\n');res.end();}}
 finally{file.buffer.fill(0);}
});
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(res.headersSent)return res.end();const typed=error instanceof ZipAnalysisError;if(error instanceof multer.MulterError){const message=error.code==='LIMIT_FILE_SIZE'?`ZIP uploads are limited to ${Math.round(uploadLimitBytes/1024/1024)} MB.`:'Upload limits were exceeded. Choose one ZIP archive and try again.';return res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({message});}if(typed)return res.status(error.status).json({message:error.message});return res.status(400).json({message:'The upload could not be processed. Choose a valid ZIP archive and try again.'});});
const port=Number(process.env.PORT??5000);if(process.env.NODE_ENV!=='test')app.listen(port,()=>console.log(`RepoScope API listening on ${port}`));
