// Own a Windows Job Object before the CLI's first instruction executes.
// This controls process lifetime only. It does not grant sandbox isolation.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class HubJobRunner {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show, reservedSize; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorking, maxWorking; public uint activeLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string s) {
    StringBuilder b = new StringBuilder("\""); int slashes = 0;
    foreach(char c in s) {
      if(c == '\\') { slashes++; continue; }
      if(c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); }
      else { b.Append('\\', slashes); b.Append(c); }
      slashes = 0;
    }
    b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
  }
  static IntPtr DuplicateStd(int n) {
    IntPtr result; Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(n), GetCurrentProcess(), out result, 0, true, 2)); return result;
  }
  static void WaitEmpty(IntPtr job) {
    IntPtr accounting=Marshal.AllocHGlobal(48);
    try { for(;;) { Check(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero)); if(Marshal.ReadInt32(accounting,40)==0)return;Thread.Sleep(25); } }
    finally {Marshal.FreeHGlobal(accounting);}
  }
  static int Main() {
    IntPtr job=IntPtr.Zero, attributes=IntPtr.Zero, handles=IntPtr.Zero;
    IntPtr[] std = new IntPtr[3]; PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    NamedPipeClientStream owner = null; string ownerNonce=null; ManualResetEvent gone = new ManualResetEvent(false);HubPinnedRoot pin=null;
    try {
      string encoded = Environment.GetEnvironmentVariable("HUB_PROCESS_SPEC");
      Environment.SetEnvironmentVariable("HUB_PROCESS_SPEC", null);
      Dictionary<string,object> spec = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(encoded);
      ownerNonce=(string)spec["nonce"];
      owner = new NamedPipeClientStream(".", (string)spec["pipe"], PipeDirection.InOut, PipeOptions.Asynchronous);
      owner.Connect(10000);
      byte[] handshake = Encoding.UTF8.GetBytes((string)spec["nonce"] + "\n"); owner.Write(handshake,0,handshake.Length); owner.Flush();
      // The owner socket closes even if Node crashes; no PID lookup or PID reuse race.
      NamedPipeClientStream channel = owner;
      // STOP is a half-duplex command: keep the authenticated return channel
      // alive so the owner can receive the post-cleanup receipt. EOF still
      // cancels the Job when the owner disappears.
      Thread monitor = new Thread(delegate() { try { while(channel.ReadByte() == 0) {} } catch {} finally { gone.Set(); } });
      monitor.IsBackground = true; monitor.Start();
      if(spec.ContainsKey("dirPin")) {Dictionary<string,object> binding=(Dictionary<string,object>)spec["dirPin"];pin=new HubPinnedRoot((string)binding["root"],(string)binding["rootFingerprint"]);}
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
      EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
      STARTUPINFOEX si = new STARTUPINFOEX(); si.info.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.info.flags = 0x100;
      std[0] = DuplicateStd(-10); std[1] = DuplicateStd(-11); std[2] = DuplicateStd(-12);
      si.info.input=std[0]; si.info.output=std[1]; si.info.error=std[2];
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
      handles=Marshal.AllocHGlobal(IntPtr.Size*3); for(int i=0;i<3;i++) Marshal.WriteIntPtr(handles,i*IntPtr.Size,std[i]);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      si.attributes=attributes;
      string file=(string)spec["file"]; StringBuilder cmd=new StringBuilder(Quote(file));
      foreach(object a in (IEnumerable)spec["args"]) cmd.Append(" ").Append(Quote((string)a));
      bool terminal=spec.ContainsKey("pty") && (bool)spec["pty"];
      Check(CreateProcess(file,cmd,IntPtr.Zero,IntPtr.Zero,true,terminal?0x00080004u:0x08080004u,IntPtr.Zero,(string)spec["cwd"],ref si,out pi));
      try { Check(AssignProcessToJobObject(job,pi.process)); }
      catch { TerminateProcess(pi.process,125); throw; }
      if(gone.WaitOne(0)) return 125;
      if(pin!=null)pin.Verify();
      Check(ResumeThread(pi.thread) != 0xffffffff);
      Console.Error.WriteLine("HUB_JOB_READY:" + (string)spec["nonce"] + ":" + pi.pid); Console.Error.Flush();
      uint wait = WaitForMultipleObjects(2,new IntPtr[]{pi.process,gone.SafeWaitHandle.DangerousGetHandle()},false,0xffffffff);
      if(wait != 0) return 125;
      uint code; Check(GetExitCodeProcess(pi.process,out code));
      IntPtr accounting = Marshal.AllocHGlobal(48);
      try {
        // Keep the run owned and busy while descendants remain, even after the root exits.
        for(;;) { Check(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero)); if(Marshal.ReadInt32(accounting,40)==0) break; if(gone.WaitOne(100)) return 125; }
      } finally { Marshal.FreeHGlobal(accounting); }
      return unchecked((int)code);
    } catch(Exception e) {
      Win32Exception native=e as Win32Exception;
      Console.Error.WriteLine("HUB_JOB_ERROR:" + (native != null ? native.NativeErrorCode.ToString() : e.GetType().Name));
      return 125;
    } finally {
      bool empty=false, rootExited=false; uint rootCode=125;
      if(job!=IntPtr.Zero) { TerminateJobObject(job,125); try {WaitEmpty(job);empty=true;} finally {CloseHandle(job);} }
      if(pi.process!=IntPtr.Zero) {TerminateProcess(pi.process,125);rootExited=WaitForSingleObject(pi.process,0xffffffff)==0; if(rootExited)Check(GetExitCodeProcess(pi.process,out rootCode));}
      if(empty && rootExited && owner!=null && owner.IsConnected) {
        try {
          var receipt=new Dictionary<string,object>{{"nonce",ownerNonce},{"rootExited",true},{"ownedTreeEmpty",true},{"cleanupVerified",true},{"exitCode",rootCode}};
          byte[] message=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(receipt)+"\n");
          owner.Write(message,0,message.Length);owner.Flush();
        } catch(IOException) { /* Owner disappeared: no receipt is claimed. */ }
      }
      if(pin!=null)pin.Dispose();
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      foreach(IntPtr h in std) if(h!=IntPtr.Zero) CloseHandle(h);
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(owner!=null) owner.Dispose();
    }
  }
}
