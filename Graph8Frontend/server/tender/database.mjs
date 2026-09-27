import Database from 'better-sqlite3';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv,createHash,randomUUID} from 'node:crypto';
import {AppError} from '../domain.mjs';

export function openTenderDb(file){
 mkdirSync(dirname(file),{recursive:true});let key;
 try{key=readFileSync(file+'.key');}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);writeFileSync(file+'.key',key,{mode:0o600,flag:'wx'});}
 if(key.length!==32)throw new Error('Invalid tender encryption key. Restore the original key with the database.');
 const db=new Database(file);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
 db.exec(`CREATE TABLE IF NOT EXISTS records(org TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(org,kind,id));
 CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,org TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,record_id TEXT NOT NULL,previous TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit history cannot be updated'); END;
 CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit history cannot be deleted'); END;`);
 const seal=(value,aad)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const b=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);};
 const open=(b,aad)=>{const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(Buffer.from(aad));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());};
 const aad=(org,kind,id)=>`${org}:${kind}:${id}`;
 const decode=r=>({...open(r.payload,aad(r.org,r.kind,r.id)),revision:r.revision});
 const get=(org,kind,id)=>{const r=db.prepare('SELECT * FROM records WHERE org=? AND kind=? AND id=?').get(org,kind,id);if(!r)throw new AppError('Record not found.',404);return decode(r);};
 const audit=(org,actor,action,id)=>{const at=new Date().toISOString(),previous=db.prepare('SELECT digest FROM audit WHERE org=? ORDER BY seq DESC LIMIT 1').get(org)?.digest||'';const digest=createHash('sha256').update(JSON.stringify([org,at,actor,action,id,previous])).digest('hex');db.prepare('INSERT INTO audit(org,at,actor,action,record_id,previous,digest) VALUES(?,?,?,?,?,?,?)').run(org,at,actor,action,id,previous,digest);};
 const put=(org,kind,row,expected)=>{const current=db.prepare('SELECT revision FROM records WHERE org=? AND kind=? AND id=?').get(org,kind,row.id);if(current&&expected!==undefined&&current.revision!==expected)throw new AppError('This record changed in another session. Refresh and try again.',409);const rev=(current?.revision||0)+1;db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(org,kind,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(org,kind,row.id,rev,seal(row,aad(org,kind,row.id)));return {...row,revision:rev};};
 return {atomic:fn=>db.transaction(fn)(),get,list:(org,kind)=>db.prepare('SELECT * FROM records WHERE org=? AND kind=? ORDER BY rowid DESC').all(org,kind).map(decode),
 create:db.transaction((org,kind,row,actor='system')=>{if(db.prepare('SELECT 1 FROM records WHERE org=? AND kind=? AND id=?').get(org,kind,row.id))throw new AppError('Duplicate record.',409);const v=put(org,kind,row);audit(org,actor,`${kind}:created`,row.id);return v;}),
 update:db.transaction((org,kind,id,actor,action,fn,expected)=>{const row=get(org,kind,id);if(expected!==undefined&&row.revision!==expected)throw new AppError('This record changed. Refresh before editing.',409);fn(row);row.updatedAt=new Date().toISOString();const v=put(org,kind,row,row.revision);audit(org,actor,action,id);return v;}),
 audit:(org)=>db.prepare('SELECT * FROM audit WHERE org=? ORDER BY seq DESC LIMIT 500').all(org),
 verifyAudit(org){let previous='';for(const r of db.prepare('SELECT * FROM audit WHERE org=? ORDER BY seq').all(org)){const digest=createHash('sha256').update(JSON.stringify([org,r.at,r.actor,r.action,r.record_id,r.previous])).digest('hex');if(r.previous!==previous||digest!==r.digest)return false;previous=r.digest;}return true;},
 id:()=>randomUUID(),close:()=>db.close()};
}
