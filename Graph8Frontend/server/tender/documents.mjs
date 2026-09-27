import {createRequire} from 'node:module';
import {AppError} from '../domain.mjs';
import JSZip from 'jszip';
import {Document,Packer,Paragraph,HeadingLevel,TextRun} from 'docx';
const require=createRequire(import.meta.url),parsePdf=require('pdf-parse/lib/pdf-parse.js');
export async function extractDocument(name,buffer){
 if(buffer.length>8*1024*1024)throw new AppError('Documents are limited to 8 MB.',413);
 const ext=name.toLowerCase().split('.').pop();let pages=[];
 if(ext==='pdf'){
  if(buffer.subarray(0,5).toString()!=='%PDF-')throw new AppError('This is not a valid PDF.');
  await parsePdf(buffer,{pagerender:async page=>{const content=await page.getTextContent();let lastY,line='',lines=[];for(const item of content.items){if(lastY!==undefined&&lastY!==item.transform[5]){lines.push(line);line='';}line+=item.str+' ';lastY=item.transform[5];}lines.push(line);const value=lines.join('\n');pages.push({page:page.pageNumber,text:value});return value;}});
 }else if(ext==='docx'){
  const archive=await JSZip.loadAsync(buffer);const entries=Object.values(archive.files);if(entries.length>1000||entries.reduce((n,e)=>n+(e._data?.uncompressedSize||0),0)>32*1024*1024)throw new AppError('DOCX expanded size is too large.');
  const xml=await archive.file('word/document.xml')?.async('string');if(!xml)throw new AppError('Invalid DOCX document.');
  const value=xml.replace(/<\/w:p>/g,'\n').replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');pages=[{page:null,text:value}];
 }
 else if(['txt','md','csv'].includes(ext))pages=[{page:1,text:buffer.toString('utf8')}];
 else throw new AppError('Upload PDF, DOCX, TXT, MD, or CSV. Scanned PDFs need OCR before upload.');
 pages.sort((a,b)=>(a.page||0)-(b.page||0));const length=pages.reduce((n,p)=>n+p.text.length,0);if(length>500000)throw new AppError('Extracted text exceeds 500,000 characters. Split the document.');
 const candidates=[];for(const p of pages){const lines=p.text.split(/\n/);for(let i=0;i<lines.length;i++){const line=lines[i].trim();if(line.length>15&&/\b(must|shall|required|mandatory|eligib|certificat|bid security)\b/i.test(line))candidates.push({title:line.slice(0,1500),mandatory:/\b(must|shall|mandatory|required)\b/i.test(line),source:`${name} · ${p.page?'page '+p.page:'paragraphs'} · line ${i+1}`});}}
 return {pages,candidates:candidates.slice(0,300),warning:length<40?'No usable text detected. OCR or a text copy is required.':'Extracted candidates require human confirmation; tables and scanned content may be incomplete.'};
}
export async function bidPackage(t,docs,assessment){
 const paragraphs=t.response.split('\n').map(line=>new Paragraph({heading:line.startsWith('# ')?HeadingLevel.TITLE:line.startsWith('## ')?HeadingLevel.HEADING_1:line.startsWith('### ')?HeadingLevel.HEADING_2:undefined,children:[new TextRun(line.replace(/^#{1,3}\s/,''))]}));
 const word=await Packer.toBuffer(new Document({creator:'Graph8 Tender Workspace',title:t.title,sections:[{children:paragraphs}]}));
 const manifest={tenderId:t.id,reference:t.reference,version:t.version,createdAt:new Date().toISOString(),deadline:t.deadline,currency:t.currency,submissionChannel:t.channel,documents:docs.map(d=>({id:d.id,name:d.name,sha256:d.sha256})),notice:'Prepared package. Downloading does not submit a bid or apply a legal signature.'};
 const zip=new JSZip();zip.file('proposal.docx',word);zip.file('proposal.md',t.response);zip.file('manifest.json',JSON.stringify(manifest,null,2));zip.file('compliance.json',JSON.stringify(t.requirements.map(r=>({title:r.title,response:r.response,source:r.source,evidence:r.evidence})),null,2));
 for(const d of docs)zip.file(`evidence/${d.id}-${d.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`,Buffer.from(d.base64,'base64'));
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
