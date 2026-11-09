// Test-only Fcitx5 on an owned disposable GNOME bus/profile.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {execute,waitFor} from './native-desktop.mjs';
export async function privateHangul() {
  assert.ok(process.env.WEBER_TEST_DISPLAY?.startsWith('isolated GNOME'));
  assert.ok(process.env.XDG_CONFIG_HOME?.startsWith('/tmp/weber-wayland-'));
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'));
  const directory=join(process.env.XDG_CONFIG_HOME,'fcitx5');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'profile'),'[Groups/0]\nName=Default\nDefault Layout=kr-kr104\nDefaultIM=hangul\n[Groups/0/Items/0]\nName=keyboard-kr-kr104\n[Groups/0/Items/1]\nName=hangul\n[GroupOrder]\n0=Default\n');
  await writeFile(join(directory,'config'),'[Hotkey/TriggerKeys]\n0=Hangul\n');
  await execute('gsettings',['set','org.gnome.desktop.input-sources','sources',"[('xkb', 'kr+kr104')]"]);
  const fd=openSync('artifacts/monaco/fcitx.log','w');
  const child=spawn('fcitx5',['--disable=xcb,classicui,notifications'],{stdio:['ignore',fd,fd]});closeSync(fd);
  const completion=new Promise(resolve=>child.once('exit',resolve));
  const context=async()=>(await execute('gdbus',['call','--session','--dest','org.fcitx.Fcitx5','--object-path','/controller','--method','org.fcitx.Fcitx.Controller1.DebugInfo'])).stdout;
  const stop=async()=>{if(child.exitCode===null)child.kill();await completion;};
  try {
    await waitFor(async()=>{try{return (await context()).includes('program:gnome-shell frontend:ibus');}catch{return false;}},'private GNOME Hangul bridge');
    return {
      async latin(){await execute('fcitx5-remote',['-c']);},
      async activate(){
        await waitFor(async()=>/program:window:\d+ frontend:ibus cap:\S+ focus:1/.test(await context()),'focused private native IME context');
        await execute('fcitx5-remote',['-s','hangul']);await execute('fcitx5-remote',['-o']);
        await waitFor(async()=>(await execute('fcitx5-remote',['-n'])).stdout.trim()==='hangul'&&(await execute('fcitx5-remote',[])).stdout.trim()==='2','private Hangul engine active');
      }, stop,
    };
  } catch(error){await stop();throw error;}
}
