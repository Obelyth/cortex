import { deviceCommand, deviceResult, deviceRoster, DeviceError, DEVICE_MESSAGES, type DeviceCommand } from "./device-contract";

export function deviceEndpoint(pathname:string) {
  const base=pathname.match(/^\/s\/[^/]+\/console(?:\/|$)/)?.[0].replace(/\/$/,"");
  if(!base)throw new DeviceError("unavailable");
  return `${base}/ops/devices`;
}
async function response(url:string,command?:DeviceCommand):Promise<unknown> {
  try {
    const res=await fetch(url,{method:command?"POST":"GET",cache:"no-store",...(command?{headers:{"Content-Type":"application/json"},body:JSON.stringify(command)}:{}),signal:AbortSignal.timeout(12_000)});
    const raw=await res.json();
    if(!res.ok)throw new DeviceError(raw&&typeof raw.code==="string"&&Object.hasOwn(DEVICE_MESSAGES,raw.code)?raw.code:command?"uncertain":"unavailable");
    return raw;
  }catch(e){if(e instanceof DeviceError)throw e;throw new DeviceError(command?"uncertain":"unavailable");}
}
export async function readDevices(url:string) {
  const parsed=deviceRoster.safeParse(await response(url));if(!parsed.success)throw new DeviceError("unavailable");return parsed.data;
}
export async function requestDevice(url:string,command:DeviceCommand) {
  const input=deviceCommand.safeParse(command);if(!input.success)throw new DeviceError("invalid");
  const parsed=deviceResult.safeParse(await response(url,input.data));if(!parsed.success)throw new DeviceError("uncertain");
  const result=parsed.data;
  const allowed:Record<DeviceCommand["action"],string[]>={prepare:["prepared"],register:["registered"],rename:["renamed"],forget:["forgotten"],visit:["visited","throttled","unregistered"]};
  if(!allowed[command.action].includes(result.outcome)||("id" in command&&"item" in result&&result.item.id!==command.id)||("id" in command&&"id" in result&&result.id!==command.id))throw new DeviceError("uncertain");
  return result;
}

/** Event-driven only: never a timer. Server SQL independently enforces the write throttle. */
export function createDeviceVisitor(visible:()=>boolean,send:(command:{action:"visit";visible:true})=>Promise<unknown>,now=Date.now) {
  let lastAttempt:number|null=null,pending=false;
  return async(force=false)=>{
    if(!visible()||pending||(!force&&lastAttempt!==null&&now()-lastAttempt<300_000))return;
    pending=true;lastAttempt=now();
    try{await send({action:"visit",visible:true});}catch{/* The inventory panel shows availability; visits never block the shell. */}
    finally{pending=false;}
  };
}
