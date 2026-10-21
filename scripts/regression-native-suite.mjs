import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
const results=[];
for(const [name,args] of [
 ['preview',['scripts/preview-native.mjs']],
 ['clipboard-browser',['scripts/clipboard-native.mjs','--browser']],
 ['clipboard-sdk',['scripts/clipboard-native.mjs']],
 ['npm-native',['scripts/npm-distribution-native.mjs']],
 ['lifetime-50',['scripts/lifecycle-native.mjs']],
 ['lifetime-200',['scripts/lifecycle-native.mjs','--cycles=200']],
]){
 const log='artifacts/activation-suite-'+name+'.log',fd=openSync(log,'w');
 const child=spawn(process.execPath,args,{stdio:['ignore',fd,fd],env:process.env});closeSync(fd);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
 results.push({name,code,log});await writeFile('artifacts/activation-suite.json',JSON.stringify({passed:false,results},null,2));
 console.log(name+': '+code);
 if(code!==0)throw new Error(name+' failed, see '+log);
}
await writeFile('artifacts/activation-suite.json',JSON.stringify({passed:true,results},null,2));
