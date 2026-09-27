import {mkdirSync,appendFileSync,statSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
export function createRequestLogger(root){
 const dir=resolve(root,'server/data/logs'),file=resolve(dir,'tender-requests.jsonl');mkdirSync(dir,{recursive:true});
 return entry=>{try{if(existsSync(file)&&statSync(file).size>5*1024*1024){const previous=file+'.1';if(existsSync(previous))unlinkSync(previous);renameSync(file,previous);}appendFileSync(file,JSON.stringify(entry)+'\n',{mode:0o600});}catch{console.error('Tender request log could not be written. Check disk space and filesystem permissions.');}};
}
