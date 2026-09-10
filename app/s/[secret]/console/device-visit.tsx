"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createDeviceVisitor, deviceEndpoint, requestDevice } from "@/lib/device-client";

/** Mounts only inside the authenticated shell; the endpoint independently authenticates. */
export function DeviceVisit() {
  const pathname=usePathname();
  const visitor=useRef<ReturnType<typeof createDeviceVisitor>|null>(null);
  useEffect(()=>{
    visitor.current??=createDeviceVisitor(()=>document.visibilityState==="visible",command=>requestDevice(deviceEndpoint(window.location.pathname),command));
    const visible=()=>{void visitor.current?.();};
    const registered=()=>{void visitor.current?.(true);};
    document.addEventListener("visibilitychange",visible);
    window.addEventListener("cortex-inventory-change",registered);
    return()=>{document.removeEventListener("visibilitychange",visible);window.removeEventListener("cortex-inventory-change",registered);};
  },[]);
  useEffect(()=>{void visitor.current?.();},[pathname]);
  return null;
}
