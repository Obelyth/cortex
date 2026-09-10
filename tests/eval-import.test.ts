import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each(["eval", "eval-prediction", "build-edges"])("importing %s does not start its CLI or contact a provider", name => {
  const result=spawnSync(process.execPath,["--input-type=module","--eval",`import {createServer} from 'vite'; const s=await createServer({configFile:false,logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true}}); try {await s.ssrLoadModule('./scripts/${name}.ts');console.log('import-only')} finally {await s.close()}`],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:"test"},encoding:"utf8",timeout:10000,
  });
  expect(result.status,result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("import-only");
});
