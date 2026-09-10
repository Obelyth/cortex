import {describe,it,expect,vi} from "vitest";
import {utf8Prefix,utf8Suffix} from "../lib/utf8";
import {parseReport} from "../lib/ops-report";
import {alertSubject,alertBody} from "../lib/mail";

describe("bounded Unicode fields",()=>{
  it("does not materialize an entire input to keep a small tail",()=>{
    const full=vi.spyOn(Array,"from"),encoded=vi.spyOn(TextEncoder.prototype,"encode");
    try {expect(utf8Suffix("x".repeat(200000)+"😀é",6)).toBe("😀é");expect(full.mock.calls.length).toBe(0);expect(encoded.mock.calls.every(([s])=>!s||s.length<=2)).toBe(true);}finally{full.mockRestore();encoded.mockRestore();}
  });
  it("preserves UTF-8 prefix and suffix boundaries",()=>{
    expect(utf8Prefix("é😀x",5)).toBe("é");expect(utf8Prefix("é😀x",6)).toBe("é😀");expect(utf8Suffix("x😀é",5)).toBe("é");expect(utf8Suffix("x😀é",6)).toBe("😀é");
  });
  it("never splits report summary, error or evidence surrogate pairs",()=>{
    const r=parseReport({unit:"fixture",verb:"finish",run_key:"one",summary:"a".repeat(279)+"😀",error:"b".repeat(3999)+"😀",evidence:["c".repeat(2047)+"😀"]});
    expect(typeof r).toBe("object");if(typeof r==="string")return;
    expect(r.summary).toBe("a".repeat(279));expect(r.error).toBe("b".repeat(3999));expect(r.evidence).toEqual(["c".repeat(2047)]);
  });
  it("keeps alert subject and body valid at each field boundary",()=>{
    const a={unit:"fixture",unitName:"a".repeat(487)+"😀",from:"running",to:"failed",error:"b".repeat(2999)+"😀",at:new Date(0),next:"inspect",boardUrl:"https://fixture.test"};
    expect(alertSubject(a).isWellFormed()).toBe(true);expect(alertBody({...a,unitName:"c".repeat(255)+"😀"}).isWellFormed()).toBe(true);
  });
});
