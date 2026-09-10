export type JsonBodyFailure="too_large"|"timeout"|"invalid"|"not_object";
/** Call only after authorization/origin checks. One bounded read and one JSON parse. */
export async function readBoundedJson(req:Request,maxBytes=65536,deadlineMs=8000):Promise<{body:Record<string,unknown>}|{failure:JsonBodyFailure}> {
  const limit=Math.min(65536,maxBytes),deadline=Math.min(8000,deadlineMs);
  const reader=req.body?.getReader();if(!reader)return{failure:"invalid"};
  const cancel=()=>{void reader.cancel().catch(()=>{});};let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([(async()=>{
    const chunks:Uint8Array[]=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){cancel();return{failure:"too_large" as const};}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const body:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!body||typeof body!=="object"||Array.isArray(body))return{failure:"not_object" as const};
    return{body:body as Record<string,unknown>};
  })(),new Promise<{failure:JsonBodyFailure}>(resolve=>{timer=setTimeout(()=>{resolve({failure:"timeout"});cancel();},deadline);})]);}
  catch{return{failure:"invalid"};}finally{clearTimeout(timer);}
}
