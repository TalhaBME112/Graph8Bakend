import test from 'node:test';
import assert from 'node:assert/strict';
import {samplePerArm,compare,decide,metricCounts,zOf} from './stats.mjs';

test('Power analysis matches standard two-proportion sample sizes',()=>{
 assert.ok(Math.abs(zOf(0.975)-1.959964)<1e-5);
 const n=samplePerArm(0.05,0.02);assert.ok(n>=2150&&n<=2260,`got ${n}`);
 assert.ok(samplePerArm(0.03,0.03)<samplePerArm(0.03,0.015),'larger effects need fewer contacts');
 assert.equal(samplePerArm(0,0.01),null);
});
test('Decision framework: keep testing, ship, early stop, no difference and guardrail',()=>{
 const plan={requiredPerArm:2210,mde:0.02};
 assert.equal(decide({A:{n:100,x:3},B:{n:100,x:4},plan}).decision,'collect');
 assert.equal(decide({A:{n:2500,x:125},B:{n:2500,x:175},plan}).decision,'ship_B');
 assert.equal(decide({A:{n:300,x:60},B:{n:300,x:6},plan}).decision,'ship_A');
 assert.equal(decide({A:{n:2300,x:115},B:{n:2300,x:118},plan}).decision,'no_difference');
 assert.equal(decide({A:{n:10,x:1},B:{n:10,x:1},plan,guardrail:{breached:true,message:'Unsubscribes 2%'}}).decision,'stop_guardrail');
 const c=compare({n:1000,x:50},{n:1000,x:80});assert.ok(c.probBBeats>0.99&&c.pValue<0.01&&c.lift>0.029);
});
test('Graph8 campaign metrics are mapped to sent / success counts',()=>{
 assert.deepEqual(metricCounts({'stats.sent':400,'stats.replied':12,'stats.reply_rate':0.03}),{n:400,x:12,sentKey:'stats.sent',successKey:'stats.replied'});
 assert.equal(metricCounts({emails_sent:50,meetings_booked:2},'meeting').x,2);
});
