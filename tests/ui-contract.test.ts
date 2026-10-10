import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const styles=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');

describe('accessible analysis experience contracts',()=>{
 it('offers keyboard-operable GitHub and ZIP modes with a real file input',()=>{expect(app).toContain('role="tablist"');expect(app).toContain('onKeyDown');expect(app).toContain('type="file"');expect(app).toContain('onDrop');});
 it('announces live progress and provides cancellation controls',()=>{expect(app).toContain('aria-live="polite"');expect(app).toContain('Cancel analysis');expect(app).toContain('AnalysisStage');});
 it('includes responsive mobile layouts and reduced-motion overrides',()=>{expect(styles).toMatch(/@media\s*\(max-width:\s*760px\)/);expect(styles).toMatch(/@media\s*\(max-width:\s*460px\)/);expect(styles).toContain('@media(prefers-reduced-motion:reduce)');expect(styles).toMatch(/prefers-reduced-motion:reduce[^}]*[\s\S]*?\.ambient\{animation:none\}/);});
});
