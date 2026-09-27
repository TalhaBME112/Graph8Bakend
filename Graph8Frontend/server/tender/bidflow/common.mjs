// Shared vocabulary for BidFlow nodes: Graph8 industry terms per marketplace category,
// geography normalisation and deterministic scoring used as the LLM fallback.
export const INDUSTRIES={
 'Software & IT':['Information Technology','Software','Computer','Internet','IT Services'],
 'Consulting':['Management Consulting','Consulting','Professional Services'],
 'Construction':['Construction','Civil Engineering','Building','Architecture'],
 'Healthcare':['Hospital','Health','Medical'],
 'Education':['Education','E-Learning','Training'],
 'Logistics':['Logistics','Transportation','Supply Chain','Warehousing','Freight'],
 'Manufacturing':['Manufacturing','Industrial','Machinery'],
 'Energy':['Energy','Renewables','Oil','Utilities','Electrical'],
 'Professional services':['Professional Services','Legal','Accounting','Staffing'],
 'Other':[],
};
export const ALL_INDUSTRIES=[...new Set(Object.values(INDUSTRIES).flat())];
const ADJACENT={'Construction':['Engineering','Real Estate','Facilities'],'Software & IT':['Telecommunications','Computer & Network Security'],'Healthcare':['Pharmaceuticals','Medical Devices'],'Energy':['Environmental Services','Engineering'],'Logistics':['Airlines','Maritime'],'Manufacturing':['Engineering','Automotive'],'Consulting':['Research','Financial Services'],'Education':['Research','Professional Training'],'Professional services':['Management Consulting','Human Resources']};
export const adjacent=cat=>ADJACENT[cat]||['Services'];

const COUNTRIES={pk:'Pakistan',in:'India',ae:'United Arab Emirates',sa:'Saudi Arabia',qa:'Qatar',om:'Oman',kw:'Kuwait',bh:'Bahrain',eg:'Egypt',tr:'Turkey',bd:'Bangladesh',lk:'Sri Lanka',ng:'Nigeria',ke:'Kenya',za:'South Africa',ca:'Canada',au:'Australia',nz:'New Zealand',sg:'Singapore',my:'Malaysia',id:'Indonesia',ph:'Philippines',de:'Germany',fr:'France',es:'Spain',it:'Italy',nl:'Netherlands',ie:'Ireland',se:'Sweden',pl:'Poland',ch:'Switzerland',br:'Brazil',mx:'Mexico',cn:'China',jp:'Japan',usa:'United States',us:'United States','u.s.':'United States','united states of america':'United States',america:'United States',uk:'United Kingdom',gb:'United Kingdom',gbr:'United Kingdom','great britain':'United Kingdom',england:'United Kingdom',scotland:'United Kingdom',wales:'United Kingdom',eng:'United Kingdom',uae:'United Arab Emirates',ksa:'Saudi Arabia',pak:'Pakistan',pol:'Poland',deu:'Germany',fra:'France',esp:'Spain',ita:'Italy',nld:'Netherlands',bel:'Belgium',irl:'Ireland',swe:'Sweden',aut:'Austria',prt:'Portugal',rou:'Romania',cze:'Czechia',hun:'Hungary',fin:'Finland',dnk:'Denmark',grc:'Greece',bgr:'Bulgaria',hrv:'Croatia',svk:'Slovakia',svn:'Slovenia',ltu:'Lithuania',lva:'Latvia',est:'Estonia',lux:'Luxembourg',nor:'Norway',che:'Switzerland'};
export function country(v){const s=String(v||'').trim();if(!s)return '';return COUNTRIES[s.toLowerCase()]||s.replace(/\b\w/g,c=>c.toUpperCase());}
export const US_STATES=['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'];
export const detectState=text=>US_STATES.find(s=>new RegExp(`\\b${s}\\b`,'i').test(text||''))||'';

const STOP=new Set('this that with from will have been shall must their which about into over under provide provision including include services service works work project projects contract tender tenders supply delivery required requirements company companies other within across public council authority lot lots each also such these those than more less been being able year years month months week weeks'.split(' '));
export function keywords(text,max=25){const counts=new Map();for(const w of String(text||'').toLowerCase().match(/[a-z][a-z-]{3,}/g)||[])if(!STOP.has(w))counts.set(w,(counts.get(w)||0)+1);return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,max).map(([w])=>w);}

const BANDS=['1-10','11-50','51-200','201-500','501-1000','1001-5000','5001-10000','10001+'];
export function idealBands(budget){if(!budget)return ['11-50','51-200','201-500','501-1000'];if(budget<250e3)return ['11-50','51-200'];if(budget<2e6)return ['51-200','201-500','501-1000'];if(budget<2e7)return ['201-500','501-1000','1001-5000'];return ['1001-5000','5001-10000','10001+'];}
export function sizeFit(band,budget){const ideal=idealBands(budget);if(!band)return 8;if(ideal.includes(band))return 20;const i=BANDS.indexOf(band),d=Math.min(...ideal.map(b=>Math.abs(BANDS.indexOf(b)-i)));return d===1?12:4;}

// Deterministic contractor fit (0-100); the LLM re-ranks on top of this.
export function ruleFit(c,{icp,parsed,tender}){
 const ind=String(c.industry||'').toLowerCase(),desc=`${c.description||''} ${c.industry||''}`.toLowerCase();
 const industry=(icp.industries||[]).some(i=>ind.includes(i.toLowerCase()))?30:(icp.industries||[]).some(i=>desc.includes(i.toLowerCase()))?18:0;
 const st=parsed.location?.state,co=country(parsed.location?.country||tender.country);
 const location=st&&c.state===st?25:co&&country(c.country)===co?15:5;
 const size=sizeFit(c.employee_count,tender.budget);
 const terms=[...new Set([...(parsed.keywords||[]),...(icp.must_have||[])].map(x=>String(x).toLowerCase()).filter(x=>x.length>3))];
 const hits=terms.filter(t=>desc.includes(t));
 const relevance=Math.min(25,hits.length*5);
 const reasons=[industry>=30?`Industry match: ${c.industry}`:industry?'Adjacent industry':'Industry outside ICP',location===25?`Located in ${st}`:location===15?`Based in ${co}`:'Outside target geography',`Size ${c.employee_count||'unknown'} vs budget`,hits.length?`Scope keywords: ${hits.slice(0,5).join(', ')}`:'No scope keywords in profile'];
 return {score:Math.min(100,industry+location+size+relevance),reasons};
}

export function titleRank(title){
 const t=String(title||'').toLowerCase();
 if(/human resources|\bhr\b|recruit|talent|payroll|compliance|accounting|accounts|it support|help ?desk|marketing coordinator|social media|intern|assistant/.test(t))return -10;
 let s=0;if(/business development|estimat|preconstruction|pre-construction|\bbid|tender|proposal|capture|sales|commercial/.test(t))s+=6;
 if(/\bceo\b|chief executive|president|owner|founder|managing director|general manager|principal|partner/.test(t))s+=5;
 if(/operations|project director|director of projects|contracts/.test(t))s+=3;
 if(/vice president|\bvp\b|director|head/.test(t))s+=1;return s;
}
export const clamp=(n,a=0,b=100)=>Math.max(a,Math.min(b,Math.round(Number(n)||0)));
export const domainOf=c=>String(c.domain||c.website||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
