import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {AppError} from '../domain.mjs';
export function isPublicV4(ip){const p=ip.split('.').map(Number);return p.length===4&&p.every(x=>Number.isInteger(x)&&x>=0&&x<=255)&&![0,10,127].includes(p[0])&&p[0]<224&&!(p[0]===169&&p[1]===254)&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&[0,168].includes(p[1]))&&!(p[0]===100&&p[1]>=64&&p[1]<=127)&&!(p[0]===198&&[18,19].includes(p[1]));}
export async function fetchSource(raw,redirects=0){
 const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new AppError('Sources require public HTTPS URLs on port 443.');
 const addresses=await lookup(url.hostname,{all:true,family:4});if(!addresses.length||addresses.some(x=>!isPublicV4(x.address)))throw new AppError('Private and reserved network addresses are not supported.');
 const result=await new Promise((resolve,reject)=>{const req=https.get(url,{lookup:(_host,_opts,cb)=>cb(null,addresses[0].address,4),headers:{Accept:'application/json','User-Agent':'Graph8TenderWorkspace/1.0'},timeout:20000},res=>{const parts=[];let bytes=0;res.on('data',b=>{bytes+=b.length;if(bytes>4*1024*1024){res.destroy();reject(new AppError('Source response exceeds 4 MB.'));}else parts.push(b);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location,body:Buffer.concat(parts).toString()}));});req.on('timeout',()=>req.destroy(new Error('Source request timed out.')));req.on('error',reject);});
 if([301,302,303,307,308].includes(result.status)){if(redirects>=3)throw new AppError('Too many source redirects.');return fetchSource(new URL(result.location,url).href,redirects+1);}
 if(result.status!==200)throw new AppError(`Source returned HTTP ${result.status}.`);
 let data;try{data=JSON.parse(result.body);}catch{throw new AppError('This connector expects a JSON feed. HTML portals need an adapter or document import.');}const items=Array.isArray(data)?data:data.tenders;if(!Array.isArray(items)||items.length>500)throw new AppError('Feed must contain at most 500 tender records.');return items;
}
