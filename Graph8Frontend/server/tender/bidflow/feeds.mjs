// Discovery node sources: public procurement feeds normalised into marketplace tenders.
// Each adapter hits an official open-data API (no keys) and returns open tenders only.
import {createHash} from 'node:crypto';
import {AppError} from '../../domain.mjs';
import {stamp} from '../model.mjs';
import {country} from './common.mjs';

const HOSTS=new Set(['www.contractsfinder.service.gov.uk','www.find-tender.service.gov.uk','search.worldbank.org','api.ted.europa.eu']);
async function getJson(url,init={}){
 const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname))throw new AppError('Feed host is not on the BidFlow allowlist.');
 const r=await fetch(u,{...init,headers:{Accept:'application/json','User-Agent':'Graph8-BidFlow/1.0',...(init.headers||{})},signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!r.ok)throw new AppError(`${u.hostname} returned HTTP ${r.status}.`,502);
 const text=await r.text();if(text.length>12e6)throw new AppError('Feed response too large.',502);return JSON.parse(text);
}
const strip=h=>String(h||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&[a-z]+;/g,' ').replace(/\s+/g,' ').trim();
const since=days=>new Date(Date.now()-days*864e5).toISOString().slice(0,10);
const pick=o=>!o?'':typeof o==='string'?o:Array.isArray(o)?pick(o[0]):pick(o.eng||o.ENG||Object.values(o)[0]);

const CPV=[[/^45/,'Construction'],[/^71/,'Construction'],[/^(72|48|30|64)/,'Software & IT'],[/^(79|73)/,'Consulting'],[/^(85|33)/,'Healthcare'],[/^80/,'Education'],[/^(60|63)/,'Logistics'],[/^(09|65|31)/,'Energy'],[/^(42|43|44|34)/,'Manufacturing'],[/^(75|66)/,'Professional services']];
const WORDS=[[/construct|building|refurbish|rehabilitat|civil works|road|bridge|hvac|roof|paving|renovat/i,'Construction'],[/software|digital|\bit\b|cloud|cyber|data|system|website|platform|licen[cs]e/i,'Software & IT'],[/health|clinic|hospital|medical|care services|nursing/i,'Healthcare'],[/school|education|training|learning|university/i,'Education'],[/transport|logistic|freight|fleet|courier|delivery services/i,'Logistics'],[/energy|solar|electric|power|utilit|renewable/i,'Energy'],[/consult|advisory|study|assessment|evaluation|audit/i,'Consulting'],[/manufactur|equipment|supply of|machinery|vehicles/i,'Manufacturing']];
export function classify(cpv,text){const c=String(cpv||'');for(const [re,cat] of CPV)if(re.test(c))return cat;for(const [re,cat] of WORDS)if(re.test(text||''))return cat;return 'Other';}

function ocds(release,{name,noticeUrl}){
 const t=release.tender||{},end=t.tenderPeriod?.endDate,addr=(t.items||[]).flatMap(i=>i.deliveryAddresses||[])[0]||(release.parties||[])[0]?.address||{};
 return {externalId:release.ocid||release.id,title:t.title,description:strip(t.description),issuer:release.buyer?.name||name,budget:Number(t.value?.amount||t.minValue?.amount||0),currency:t.value?.currency||'GBP',deadline:end,country:country(addr.countryName||'United Kingdom'),region:addr.region||addr.locality||'',category:classify(t.classification?.id,`${t.title} ${t.description}`),sourceUrl:noticeUrl(release)};
}
export const ADAPTERS={
 contracts_finder:{name:'UK Contracts Finder',about:'UK public sector notices (OCDS), stage=tender',async fetch(limit){const d=await getJson(`https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?stage=tender&limit=${limit}&publishedFrom=${since(10)}`);return (d.releases||[]).map(r=>ocds(r,{name:'UK public buyer',noticeUrl:r=>`https://www.contractsfinder.service.gov.uk/Notice/${String(r.ocid||'').replace(/^ocds-b5fd17-/,'')}`}));}},
 find_a_tender:{name:'UK Find a Tender',about:'High-value UK tenders (OCDS release packages)',async fetch(limit){const d=await getJson(`https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=${limit}&stages=tender&updatedFrom=${since(10)}T00:00:00`);return (d.releases||[]).map(r=>ocds(r,{name:'UK public buyer',noticeUrl:r=>`https://www.find-tender.service.gov.uk/Notice/${r.id}`}));}},
 world_bank:{name:'World Bank procurement',about:'Invitations for Bids on World Bank-financed projects',async fetch(limit){const d=await getJson(`https://search.worldbank.org/api/v2/procnotices?format=json&rows=${limit}&notice_type_exact=Invitation%20for%20Bids&srt=submission_date&order=desc`);return (d.procnotices||[]).map(n=>({externalId:n.id,title:strip(n.bid_description).slice(0,200)||n.project_name,description:strip(`${n.project_name}. ${n.bid_description}. ${n.notice_text}`).slice(0,6000),issuer:n.contact_organization||n.project_name,budget:0,currency:'USD',deadline:n.submission_deadline_date,country:country(n.project_ctry_name),region:'',category:n.procurement_group==='CW'?'Construction':n.procurement_group==='CS'?'Consulting':classify('',`${n.bid_description} ${n.project_name}`),sourceUrl:`https://projects.worldbank.org/en/projects-operations/procurement-detail/${n.id}`,contact:n.contact_email?{name:n.contact_name,email:n.contact_email}:null}));}},
 ted:{name:'EU TED',about:'EU Official Journal contract notices',async fetch(limit){const d=await getJson('https://api.ted.europa.eu/v3/notices/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:`notice-type IN (cn-standard) AND publication-date>=${since(7).replace(/-/g,'')}`,fields:['publication-number','notice-title','buyer-name','deadline-receipt-tender-date-lot','organisation-country-buyer','classification-cpv','estimated-value-lot','estimated-value-cur-lot','description-lot'],limit,scope:'ACTIVE'})});return (d.notices||[]).map(n=>{const dl=(n['deadline-receipt-tender-date-lot']||[])[0];return {externalId:n['publication-number'],title:pick(n['notice-title']).slice(0,250),description:pick(n['description-lot']),issuer:pick(n['buyer-name']),budget:Number((n['estimated-value-lot']||[])[0]||0),currency:(n['estimated-value-cur-lot']||[])[0]||'EUR',deadline:dl?new Date(dl.replace(/([+-]\d{2}:\d{2})$/,'T12:00:00$1')).toISOString():null,country:country((n['organisation-country-buyer']||[])[0]),region:'',category:classify((n['classification-cpv']||[])[0],pick(n['notice-title'])),sourceUrl:`https://ted.europa.eu/en/notice/-/detail/${n['publication-number']}`};});}},
};

export function feedRecords(db,org){
 const existing=db.list(org,'bidflow-feed');
 for(const [type,a] of Object.entries(ADAPTERS))if(!existing.some(f=>f.type===type))db.create(org,'bidflow-feed',{id:type,type,name:a.name,about:a.about,enabled:type!=='ted',limit:25,createdAt:stamp()},'bidflow');
 return db.list(org,'bidflow-feed');
}

export async function syncFeed(db,org,feedId,actor='feed-monitor'){
 const feed=db.get(org,'bidflow-feed',feedId),adapter=ADAPTERS[feed.type];if(!adapter)throw new AppError('Unknown feed adapter.');
 let added=0,skipped=0;const items=await adapter.fetch(Math.min(100,feed.limit||25));
 const sig=t=>`${String(t.title).trim().toLowerCase()}|${String(t.issuer||'').trim().toLowerCase()}|${String(t.deadline).slice(0,10)}`;
 const seen=new Set(db.list(org,'market-tender').filter(t=>t.external).map(sig));
 for(const x of items){
  if(!x.title||!x.deadline||!Number.isFinite(Date.parse(x.deadline))||Date.parse(x.deadline)<=Date.now()){skipped++;continue;}
  const id='ext-'+createHash('sha256').update(feed.type+':'+x.externalId).digest('hex').slice(0,24);
  try{db.get(org,'market-tender',id);skipped++;continue;}catch{}
  const key=sig({title:x.title,issuer:x.issuer,deadline:new Date(x.deadline).toISOString()});if(seen.has(key)){skipped++;continue;}seen.add(key);
  let currency=/^[A-Z]{3}$/.test(x.currency||'')?x.currency:'USD';
  db.create(org,'market-tender',{id,external:true,source:{feed:feed.type,name:adapter.name,externalId:x.externalId,contact:x.contact||null},issuerId:'external',issuer:String(x.issuer||adapter.name).slice(0,200),title:String(x.title).slice(0,250),description:String(x.description||x.title).slice(0,20000),category:x.category,country:x.country||'International',region:x.region||'',currency,budget:Number.isFinite(x.budget)?x.budget:0,deadline:new Date(x.deadline).toISOString(),sourceUrl:x.sourceUrl,status:'published',publishedAt:stamp(),createdAt:stamp(),documents:[],amendments:[],questions:[]},actor);
  added++;
 }
 db.update(org,'bidflow-feed',feedId,actor,'feed:synced',f=>{f.lastSync=stamp();f.lastResult={added,skipped,fetched:items.length};f.error=null;});
 return {added,skipped,fetched:items.length};
}
