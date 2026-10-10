import {describe,it,expect} from 'vitest';
import {analyzeAI} from '../server/src/analyzers/aiGenerationAnalyzer';
import {classify} from '../server/src/services/github/githubCommitService';
import {parseGithubUrl} from '../server/src/utils/parseGithubUrl';

describe('repository heuristics',()=>{
 it('returns identical AI estimates for identical inputs',()=>{const input={files:[{path:'src/app.ts',content:'const item = data;\nconst item = data;\n'}],commits:[{message:'feat: add app',additions:1200,date:'2026-01-01'}],readme:'# App\n\n## Setup\n'};expect(analyzeAI(input)).toEqual(analyzeAI(input));});
 it('keeps the score normalized and exposes limitations',()=>{const result=analyzeAI({files:[],commits:[],readme:''});expect(result.score).toBeGreaterThanOrEqual(0);expect(result.score).toBeLessThanOrEqual(100);expect(result.limitations.length).toBeGreaterThan(0);});
 it('classifies common commit message categories',()=>{expect(classify('feat: add login')).toBe('Feature');expect(classify('fix broken route')).toBe('Fix');expect(classify('docs: update readme')).toBe('Documentation');});
 it('accepts GitHub repository URLs and rejects other hosts or extra paths',()=>{expect(parseGithubUrl('https://github.com/acme/project.git')).toEqual({owner:'acme',repo:'project'});expect(parseGithubUrl('https://example.com/acme/project')).toBeNull();expect(parseGithubUrl('https://github.com/acme/project/tree/main')).toBeNull();});
});
