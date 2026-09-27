// Fetch helper for /api/growth — same headers as the workspace shell (admin token when set).
export async function growthApi<T=any>(path:string,method='GET',body?:unknown):Promise<T>{
 const token=sessionStorage.getItem('g8-access');
 const r=await fetch('/api/growth/'+path,{method,headers:{'Content-Type':'application/json','X-Workspace-Client':'growth-ui',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 let d:any;try{d=await r.json();}catch{throw new Error('The workspace server is unavailable. Start npm run server and try again.');}
 if(!r.ok)throw new Error(d.error||'Request failed');return d as T;
}
export const money=(n:number,c='USD')=>{try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c||'USD',maximumFractionDigits:0}).format(n||0);}catch{return `${c} ${n}`;}};
export const ago=(iso?:string)=>{if(!iso)return '';const s=Math.round((Date.now()-Date.parse(iso))/1000);return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':s<86400?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago';};
