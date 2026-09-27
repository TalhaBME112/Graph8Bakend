// Experiment statistics for the Campaign Learning Lab: pre-registered power analysis and a
// transparent decision framework (frequentist test + Bayesian probability + guardrails).

// Inverse standard normal CDF (Acklam's approximation, |error| < 1.2e-9).
export function zOf(p){
 const a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.357751867269,-30.66479806614716,2.506628277459239],b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572],c=[-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783],d=[0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
 if(p<0.02425){const q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
 if(p>1-0.02425)return -zOf(1-p);
 const q=p-0.5,r=q*q;return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
export function phi(x){const t=1/(1+0.2316419*Math.abs(x)),y=t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));const p=1-Math.exp(-x*x/2)/Math.sqrt(2*Math.PI)*y;return x>=0?p:1-p;}

// Contacts needed per arm to detect an absolute lift `mde` over `baseline` (two-sided).
export function samplePerArm(baseline,mde,alpha=0.05,power=0.8){
 const p1=baseline,p2=Math.min(0.999,baseline+mde);if(!(p1>0&&p1<1&&mde>0))return null;
 const pb=(p1+p2)/2,za=zOf(1-alpha/2),zb=zOf(power);
 return Math.ceil((za*Math.sqrt(2*pb*(1-pb))+zb*Math.sqrt(p1*(1-p1)+p2*(1-p2)))**2/(p2-p1)**2);
}

// Counts per arm → frequentist + Bayesian comparison of B vs A.
export function compare(A,B){
 const pa=A.n?A.x/A.n:0,pb=B.n?B.x/B.n:0,pool=(A.x+B.x)/Math.max(1,A.n+B.n);
 const se=Math.sqrt(pool*(1-pool)*(1/Math.max(1,A.n)+1/Math.max(1,B.n)));const z=se?(pb-pa)/se:0,pValue=2*(1-phi(Math.abs(z)));
 // Beta(1+x, 1+n-x) posteriors, normal approximation for P(B > A) and expected loss.
 const post=({x,n})=>{const a=1+x,b=1+n-x;return {m:a/(a+b),v:a*b/((a+b)**2*(a+b+1))};};
 const qa=post(A),qb=post(B),sd=Math.sqrt(qa.v+qb.v),probBBeats=sd?phi((qb.m-qa.m)/sd):0.5;
 const diff=qb.m-qa.m,loss=(mu)=>sd*(Math.exp(-((mu/sd)**2)/2)/Math.sqrt(2*Math.PI))+mu*phi(mu/sd); // E[max(0, other - chosen)]
 return {rateA:pa,rateB:pb,lift:pb-pa,relativeLift:pa?(pb-pa)/pa:null,z,pValue,probBBeats,expectedLossShipB:sd?loss(-diff):0,expectedLossShipA:sd?loss(diff):0};
}

// Pre-registered decision rule. Returns a verdict the UI can explain line by line.
export function decide({A,B,plan={},guardrail=null}){
 const alpha=plan.alpha??0.05,need=plan.requiredPerArm||30,threshold=plan.probabilityThreshold??0.95,lossCap=plan.lossThreshold??0.002;
 const c=compare(A,B),progress=Math.min(A.n,B.n)/need,reasons=[];
 reasons.push(`Sample: ${Math.min(A.n,B.n).toLocaleString()} of ${need.toLocaleString()} required per arm (${Math.round(progress*100)}%).`);
 reasons.push(`Observed ${(c.rateA*100).toFixed(2)}% (A) vs ${(c.rateB*100).toFixed(2)}% (B): absolute lift ${(c.lift*100).toFixed(2)} pp.`);
 reasons.push(`Two-proportion z-test p = ${c.pValue.toFixed(4)} (α = ${alpha}); P(B beats A) = ${(c.probBBeats*100).toFixed(1)}%.`);
 if(guardrail?.breached){reasons.push(`Guardrail breached: ${guardrail.message}`);return {decision:'stop_guardrail',label:'Stop — guardrail breached',...c,progress,reasons};}
 if(progress<1){
  // Early stop only for overwhelming evidence (Bayesian ≥ 99.5%), otherwise keep collecting.
  if(Math.min(A.n,B.n)>=30&&(c.probBBeats>=0.995||c.probBBeats<=0.005)){const w=c.probBBeats>0.5?'B':'A';reasons.push(`Early-stop rule met: P(${w} is better) ≥ 99.5%.`);return {decision:`ship_${w}`,label:`Ship ${w} (early stop)`,...c,progress,reasons};}
  reasons.push('Keep collecting: the pre-registered sample has not been reached.');return {decision:'collect',label:'Keep testing',...c,progress,reasons};
 }
 const winner=c.probBBeats>=threshold&&c.pValue<alpha&&c.expectedLossShipB<=lossCap?'B':c.probBBeats<=1-threshold&&c.pValue<alpha&&c.expectedLossShipA<=lossCap?'A':null;
 if(winner){reasons.push(`Decision rule met: probability ≥ ${threshold*100}%, p < ${alpha}, expected loss ≤ ${(lossCap*100).toFixed(2)} pp.`);return {decision:`ship_${winner}`,label:`Ship ${winner}`,...c,progress,reasons};}
 reasons.push(`No variant cleared the pre-registered bar at full sample: treat as no meaningful difference (below the ${((plan.mde||0)*100).toFixed(1)} pp MDE). Keep the control and test a bolder change.`);
 return {decision:'no_difference',label:'No meaningful difference',...c,progress,reasons};
}

// Finds send/success counts in a flattened Graph8 campaign-metrics object.
export function metricCounts(flat,metric='reply'){
 const keys=Object.keys(flat||{}),pick=re=>{const k=keys.find(k=>re.test(k));return k?{key:k,value:Number(flat[k])||0}:null;};
 const sent=pick(/(^|\.)(contacts_)?(sent|delivered|emails_sent|total_sent)(_count)?$/i)||pick(/sent/i)||pick(/enrolled|contacts/i);
 const re=metric==='meeting'?/meeting|booked/i:metric==='open'?/open(ed|s)?(_count)?$/i:metric==='click'?/click/i:/repl(y|ied|ies)(_count)?$/i;
 const success=pick(re);
 return {n:sent?.value||0,x:success?.value||0,sentKey:sent?.key||null,successKey:success?.key||null};
}
