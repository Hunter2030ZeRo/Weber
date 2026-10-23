from pathlib import Path
import subprocess,shlex
root=Path(__file__).resolve().parent.parent
out=root/'target/test-tools/input';out.mkdir(parents=True,exist_ok=True)
xml=root/'native/testing/virtual-keyboard-unstable-v1.xml'
subprocess.run(['wayland-scanner','client-header',str(xml),str(out/'virtual-keyboard-client.h')],check=True)
subprocess.run(['wayland-scanner','private-code',str(xml),str(out/'virtual-keyboard-code.c')],check=True)
pointer=root/'native/testing/wlr-virtual-pointer-unstable-v1.xml'
subprocess.run(['wayland-scanner','client-header',str(pointer),str(out/'virtual-pointer-client.h')],check=True)
subprocess.run(['wayland-scanner','private-code',str(pointer),str(out/'virtual-pointer-code.c')],check=True)
flags=shlex.split(subprocess.check_output(['pkg-config','--cflags','--libs','wayland-client','xkbcommon'],text=True))
subprocess.run(['cc','-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+str(out),str(root/'native/testing/wayland-keyboard.c'),str(out/'virtual-keyboard-code.c'),str(out/'virtual-pointer-code.c'),*flags,'-o',str(out/'weber-wayland-keyboard')],check=True)
print(out/'weber-wayland-keyboard')
