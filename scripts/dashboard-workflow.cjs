"use strict";
// Fixed workflow validator: no shell input, provider credential or arbitrary command surface.
const fs=require("node:fs");
function validateWorkflow(env){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(env.REQUEST_ID||"")||!/^[a-f0-9]{40}$/.test(env.SOURCE_SHA||"")||env.SOURCE_SHA!==env.GITHUB_SHA)throw new Error("Workflow source or request identity conflict");
  if(!["checks","migrations.check","migrations.apply"].includes(env.OPERATION))throw new Error("Workflow operation refused");
  if(env.OPERATION.startsWith("migrations.")){
    if(!/^supabase:[a-z]{20}:postgres$/.test(env.TARGET_IDENTITY||""))throw new Error("Workflow target unavailable");
    if(env.OPERATION==="migrations.apply"&&!/^[a-f0-9]{64}$/.test(env.PENDING_DIGEST||""))throw new Error("Workflow pending digest unavailable");
  }else if(env.TARGET_IDENTITY!==`github:${env.GITHUB_REPOSITORY}`||env.PENDING_DIGEST)throw new Error("Workflow target conflict");
  return {operation:env.OPERATION};
}
function privateCorpusPresent(root){
  let count=0,entries=0;
  const visit=(dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(++entries>20000)throw new Error("Private corpus inspection over capacity");if(entry.name===".git"||entry.isSymbolicLink())continue;const path=require("node:path").join(dir,entry.name);if(entry.isDirectory())visit(path);else if(entry.isFile()&&entry.name.endsWith(".md")&&fs.statSync(path).size>0)count++;}};
  visit(root);if(count===0)throw new Error("Private corpus unavailable");return count;
}
module.exports={validateWorkflow,privateCorpusPresent};
if(require.main===module){try{if(process.argv[2]==="validate")validateWorkflow(process.env);else if(process.argv[2]==="private-presence")privateCorpusPresent(".brain");else throw new Error("Unknown workflow operation");console.log("Fixed workflow prerequisite verified");}catch{console.error("Workflow prerequisite unavailable or conflicting; no gate success claimed");process.exitCode=1;}}
