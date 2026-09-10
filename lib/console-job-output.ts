import {redact} from "./redact";
export type ProviderFetch=(url:string,init?:RequestInit)=>Promise<Response>;
export interface SafeJobOutput {available:boolean;text:string;clipped:boolean}
export async function providerFetch(url:string,init:RequestInit,fetcher:ProviderFetch=fetch):Promise<Response>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([fetcher(url,{...init,cache:"no-store",redirect:init.redirect??"error",signal:controller.signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("Provider unavailable"));},8000);})]);}
  finally{clearTimeout(timer);}
}
export async function boundedProviderText(response:Response,maxBytes=256*1024):Promise<string>{
  const declared=response.headers.get("content-length");if(declared&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw new Error("Provider output unavailable");
  const reader=response.body?.getReader();if(!reader)return "";
  let timer:ReturnType<typeof setTimeout>|undefined;
  const read=async()=>{const chunks:Uint8Array[]=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){void reader.cancel();throw new Error("Provider output unavailable");}chunks.push(value);}const all=new Uint8Array(size);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.byteLength;}return new TextDecoder("utf-8",{fatal:true}).decode(all);};
  try{return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void reader.cancel();reject(new Error("Provider output unavailable"));},8000);})]);}finally{clearTimeout(timer);}
}
export async function providerJson(response:Response):Promise<unknown>{return JSON.parse(await boundedProviderText(response));}
export function clipSafeText(raw:string,maxBytes=16384,exactSecrets:readonly string[]=[]):{text:string;clipped:boolean}{
  // Remove complete credential-bearing URLs before substitutions can split their syntax.
  raw=raw.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"<>]+/gi,value=>{try{const url=new URL(value);return url.username||url.password||url.search?"<redacted-url>":value;}catch{return "<redacted-url>";}});
  // Remove known management values, including opaque provider tokens with no prefix.
  // Callers pass a fixed, small set of server configuration values, never browser patterns.
  for(const secret of exactSecrets)if(secret)raw=raw.split(secret).join("<redacted-token>");
  const clean=redact(raw);
  if(Buffer.byteLength(clean)<=maxBytes)return {text:clean,clipped:false};
  const marker="\n[excerpt clipped]";let text="",size=Buffer.byteLength(marker);
  for(const point of clean){const length=Buffer.byteLength(point);if(size+length>maxBytes)break;text+=point;size+=length;}
  return {text:text+marker,clipped:true};
}
export async function safeOutput(response:Response,exactSecrets:readonly string[]=[]):Promise<SafeJobOutput>{
  if(!response.ok)throw new Error("Provider output unavailable");
  return {available:true,...clipSafeText(await boundedProviderText(response,1024*1024),16384,exactSecrets)};
}
