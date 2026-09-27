import {AppError} from '../domain.mjs';
import {can,liveCall} from './graph8.mjs';
export function aiAvailability(org){return {configured:!!process.env.TENDER_LLM_SKILL_ID,permitted:can(org,'workflows:run'),scope:'workflows:run',mode:'Graph8 LLM skill; proposed text requires review'};}
export async function graph8BidDraft(org,source,call=liveCall){
 if(!can(org,'workflows:run'))throw new AppError('Graph8 AI drafting requires workflows:run. The connected key is read-only.',403);
 const skillId=process.env.TENDER_LLM_SKILL_ID;if(!skillId)throw new AppError('Configure TENDER_LLM_SKILL_ID with an evidence-grounded Graph8 LLM skill accepting source_text.',409);
 const response=await call('get_skill_skills__action_id__get',{path:{action_id:skillId}}),skill=response.data||response;
 if(skill.type!=='llm')throw new AppError('Tender drafting only permits a configured LLM skill; API and outreach skills are not allowed.',409);
 const result=await call('execute_skill_skills__action_id__execute_post',{path:{action_id:skillId},body:{source_text:JSON.stringify(source)}},{maxRetries:0});
 const data=result.data||result,output=data.result??data.output??data.response;
 const proposal=typeof output==='string'?output:output?.proposal;
 if(typeof proposal!=='string'||proposal.length<40||proposal.length>100000)throw new AppError('Graph8 did not return a final proposal text. Review the execution in Graph8 before retrying.',502);
 return {proposal,skillId,source:'Graph8 LLM skill',generatedAt:new Date().toISOString(),reviewRequired:true};
}
