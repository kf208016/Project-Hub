// Native owned child launcher and one-use migration-validation capability.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using C=HubSshMaintenanceCommon;
public sealed class HubSshMaintenanceProcess : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SA {public int size;public IntPtr descriptor;public int inherit;}
  [StructLayout(LayoutKind.Sequential)] struct SI {public int cb;public IntPtr reserved,desktop,title;public int x,y,xs,ys,xc,yc,fill,flags;public short show,reservedSize;public IntPtr reservedBytes,input,output,error;}
  [StructLayout(LayoutKind.Sequential)] struct SIX {public SI info;public IntPtr attributes;}
  [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct LIMIT {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
  [StructLayout(LayoutKind.Sequential)] struct XLIMIT {public LIMIT basic;public IO io;public UIntPtr process,job,peakProcess,peakJob;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int k,ref XLIMIT i,uint n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int k,IntPtr i,uint n,IntPtr r);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool b);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint e);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint e);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string a,StringBuilder c,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr p,uint t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint c);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr r,out IntPtr w,ref SA a,uint s);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint m,uint f);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr l,int c,int f,ref IntPtr s);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr l,uint f,IntPtr a,IntPtr v,IntPtr s,IntPtr p,IntPtr r);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr l);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool i,uint p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out long c,out long e,out long k,out long u);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr p,uint f,StringBuilder b,ref uint n);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint r,out IntPtr d,out uint n);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipe(string n,uint a,uint m,uint c,uint o,uint i,uint t,ref SA sa);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr h,out uint p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr h,out uint p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  IntPtr job;PI child;FileStream input,output,error;NamedPipeServerStream pipe;MemoryStream captured=new MemoryStream();Thread outputThread,errorThread;volatile bool failed;string file,hash;long created;readonly Stopwatch timer=Stopwatch.StartNew();
  public sealed class Result {public int ExitCode;public uint Pid;public long Created;public Dictionary<string,object> Json;}
  static void Check(bool b){C.Require(b,"NATIVE_CHILD_OPERATION_FAILED");}
  public static long Created(IntPtr p){long c,e,k,u;Check(GetProcessTimes(p,out c,out e,out k,out u));return c;}
  static string Sid(IntPtr p){IntPtr t;Check(OpenProcessToken(p,8,out t));try{using(var i=new WindowsIdentity(t))return i.User.Value;}finally{CloseHandle(t);}}
  static string Image(IntPtr p){StringBuilder b=new StringBuilder(32768);uint n=32768;Check(QueryFullProcessImageName(p,0,b,ref n));return b.ToString();}
  static string Quote(string text){StringBuilder b=new StringBuilder("\"");int slash=0;foreach(char c in text){if(c=='\\'){slash++;continue;}if(c=='\"')b.Append('\\',slash*2+1);else b.Append('\\',slash);b.Append(c);slash=0;}return b.Append('\\',slash*2).Append('"').ToString();}
  static void VerifyImage(IntPtr p,string expected,string digest){C.Require(String.Equals(Image(p),expected,StringComparison.OrdinalIgnoreCase)&&Sid(p)==C.Sid,"CHILD_IDENTITY_REJECTED");using(var f=C.HoldFile(expected,16*1024*1024))C.Require(C.Hash(C.Read(f))==digest,"CHILD_IMAGE_CHANGED");}
  static byte[] ReadExact(Stream s,int count,int timeout){byte[] b=new byte[count];int at=0;Stopwatch w=Stopwatch.StartNew();while(at<count){int remain=timeout-(int)w.ElapsedMilliseconds;C.Require(remain>0,"CAPABILITY_TIMEOUT");IAsyncResult a=s.BeginRead(b,at,count-at,null,null);try{if(!a.AsyncWaitHandle.WaitOne(remain)){s.Dispose();try{s.EndRead(a);}catch{}throw new InvalidOperationException("CAPABILITY_TIMEOUT");}int n=s.EndRead(a);C.Require(n>0,"CAPABILITY_EOF");at+=n;}finally{a.AsyncWaitHandle.Close();}}return b;}
  void CreateCapabilityPipe(string name){IntPtr sd=IntPtr.Zero,h=IntPtr.Zero;uint n;Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;"+C.Sid+")",1,out sd,out n));try{SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.descriptor=sd;h=CreateNamedPipe("\\\\.\\pipe\\"+name,0x40080003,8,1,4096,4096,0,ref sa);Check(h!=new IntPtr(-1));pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,new SafePipeHandle(h,true));h=IntPtr.Zero;}finally{if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);if(sd!=IntPtr.Zero)LocalFree(sd);}}
  void Launch(string executable,string digest,Dictionary<string,object> request,string envKey,string capName){file=executable;hash=digest;job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);XLIMIT lim=new XLIMIT();lim.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref lim,(uint)Marshal.SizeOf(typeof(XLIMIT))));IntPtr[] h=new IntPtr[6];IntPtr attrs=IntPtr.Zero,list=IntPtr.Zero,env=IntPtr.Zero;
    try{SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.inherit=1;Check(CreatePipe(out h[0],out h[1],ref sa,0));Check(CreatePipe(out h[2],out h[3],ref sa,0));Check(CreatePipe(out h[4],out h[5],ref sa,0));Check(SetHandleInformation(h[1],1,0));Check(SetHandleInformation(h[2],1,0));Check(SetHandleInformation(h[4],1,0));SIX si=new SIX();si.info.cb=Marshal.SizeOf(typeof(SIX));si.info.flags=0x100;si.info.input=h[0];si.info.output=h[3];si.info.error=h[5];IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attrs=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attrs,1,0,ref size));list=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(list,0,h[0]);Marshal.WriteIntPtr(list,IntPtr.Size,h[3]);Marshal.WriteIntPtr(list,IntPtr.Size*2,h[5]);Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),list,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));si.attributes=attrs;
      var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);values["SystemRoot"]=windows;values["WINDIR"]=windows;values["PATH"]=Path.Combine(windows,"System32");values[envKey]=Convert.ToBase64String(C.Utf8.GetBytes(C.Canon(request)));if(capName!=null)values["HUB_MAINTENANCE_CAPABILITY_PIPE"]=capName;StringBuilder block=new StringBuilder();foreach(var pair in values)block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');block.Append('\0');env=Marshal.StringToHGlobalUni(block.ToString());Check(CreateProcess(file,new StringBuilder(Quote(file)),IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,Path.GetDirectoryName(file),ref si,out child));try{
#if HUB_SSH_MAINTENANCE_PROCESS_TEST
      if(Environment.GetEnvironmentVariable("HUB_MAINTENANCE_PROCESS_FAULT")!="nonowned")
#endif
      Check(AssignProcessToJobObject(job,child.process));}catch{TerminateProcess(child.process,125);throw;}created=Created(child.process);VerifyImage(child.process,file,hash);
      input=new FileStream(new SafeFileHandle(h[1],true),FileAccess.Write);h[1]=IntPtr.Zero;input.Dispose();output=new FileStream(new SafeFileHandle(h[2],true),FileAccess.Read);h[2]=IntPtr.Zero;error=new FileStream(new SafeFileHandle(h[4],true),FileAccess.Read);h[4]=IntPtr.Zero;outputThread=new Thread(ReadOutput);outputThread.IsBackground=true;outputThread.Start();errorThread=new Thread(ReadError);errorThread.IsBackground=true;errorThread.Start();Check(ResumeThread(child.thread)!=0xffffffff);
    }finally{foreach(IntPtr x in h)if(x!=IntPtr.Zero)CloseHandle(x);if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);}
  }
  void ReadOutput(){byte[] b=new byte[4096];try{int n;while((n=output.Read(b,0,b.Length))>0){C.Require(captured.Length+n<=65536,"CHILD_OUTPUT_LIMIT");captured.Write(b,0,n);}}catch{failed=true;}finally{Array.Clear(b,0,b.Length);}}
  void ReadError(){byte[] b=new byte[4096];int total=0;try{int n;while((n=error.Read(b,0,b.Length))>0){total+=n;C.Require(total<=131072,"CHILD_DIAGNOSTIC_LIMIT");}}catch{failed=true;}finally{Array.Clear(b,0,b.Length);}}
#if HUB_SSH_MAINTENANCE_PROCESS_TEST
  static string replayedCapability;
#endif
  void Supply(Dictionary<string,object> manifest,int ordinal){IAsyncResult a=pipe.BeginWaitForConnection(null,null);try{C.Require(a.AsyncWaitHandle.WaitOne(5000),"CAPABILITY_CONNECT_TIMEOUT");pipe.EndWaitForConnection(a);}finally{a.AsyncWaitHandle.Close();}uint pid;Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid));C.Require(pid==child.pid&&Created(child.process)==created&&WaitForSingleObject(child.process,0)==258,"CAPABILITY_PEER_REJECTED");bool owned;Check(IsProcessInJob(child.process,job,out owned));C.Require(owned,"CAPABILITY_JOB_REJECTED");VerifyImage(child.process,file,hash);
    var cap=new Dictionary<string,object>{{"version",1},{"manifestSHA256",C.Binding(manifest)},{"migrationId",manifest["migrationId"]},{"ordinal",ordinal},{"nonce",Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N")},{"expiresAt",HubSshMaintenanceState.Now()+30},{"pid",(int)pid},{"created",created.ToString(System.Globalization.CultureInfo.InvariantCulture)},{"helperPid",(int)GetCurrentProcessId()},{"helperCreated",Created(GetCurrentProcess()).ToString(System.Globalization.CultureInfo.InvariantCulture)}};
#if HUB_SSH_MAINTENANCE_PROCESS_TEST
    string injected=Environment.GetEnvironmentVariable("HUB_MAINTENANCE_PROCESS_FAULT");
    if(injected=="pid")cap["pid"]=1;
    if(injected=="created")cap["created"]="1";
    if(injected=="expired")cap["expiresAt"]=HubSshMaintenanceState.Now()-1;
    if(injected=="helper-pid")cap["helperPid"]=1;
    if(injected=="helper-created")cap["helperCreated"]="1";
    if(injected=="capture-replay")replayedCapability=C.Canon(cap);
#endif
    byte[] bytes=C.Utf8.GetBytes(C.Canon(cap));
#if HUB_SSH_MAINTENANCE_PROCESS_TEST
    if(injected=="replay"){C.Require(replayedCapability!=null,"TEST_REPLAY_MISSING");bytes=C.Utf8.GetBytes(replayedCapability);}
#endif
    byte[] length=BitConverter.GetBytes(bytes.Length);pipe.Write(length,0,length.Length);pipe.Write(bytes,0,bytes.Length);pipe.Flush();pipe.Dispose();
  }
  Result Wait(){while(!failed&&timer.ElapsedMilliseconds<45000){uint s=WaitForSingleObject(child.process,50);if(s==0)break;C.Require(s==258,"CHILD_WAIT_FAILED");}C.Require(!failed&&timer.ElapsedMilliseconds<45000,"CHILD_DEADLINE");uint code;Check(GetExitCodeProcess(child.process,out code));Check(TerminateJobObject(job,125));C.Require(EmptyJob(),"CHILD_CLEANUP_UNKNOWN");C.Require(outputThread.Join(3000)&&errorThread.Join(3000)&&!failed,"CHILD_OUTPUT_INCOMPLETE");string text=C.Utf8.GetString(captured.ToArray()).TrimEnd('\r','\n');return new Result{ExitCode=unchecked((int)code),Pid=child.pid,Created=created,Json=C.Parse(text)};}
  bool EmptyJob(){IntPtr m=Marshal.AllocHGlobal(48);try{for(int i=0;i<150;i++){Check(QueryInformationJobObject(job,1,m,48,IntPtr.Zero));if(Marshal.ReadInt32(m,40)==0)return true;Thread.Sleep(20);}return false;}finally{Marshal.FreeHGlobal(m);}}
  public static Result Run(string file,string sha,Dictionary<string,object> req,bool oldBroker,Dictionary<string,object> manifest,int ordinal){using(var x=new HubSshMaintenanceProcess()){string name=ordinal>0?"ProjectHub.SshMaintenance."+Guid.NewGuid().ToString("N"):null;if(name!=null)x.CreateCapabilityPipe(name);x.Launch(file,sha,req,oldBroker?"HUB_SSH_VAULT_REQUEST":"HUB_SSH_MAINTENANCE_REQUEST",name);if(name!=null)x.Supply(manifest,ordinal);return x.Wait();}}
  public static void Accept(Dictionary<string,object> manifest,int ordinal){string name=Environment.GetEnvironmentVariable("HUB_MAINTENANCE_CAPABILITY_PIPE");Environment.SetEnvironmentVariable("HUB_MAINTENANCE_CAPABILITY_PIPE",null);C.Require(name!=null&&System.Text.RegularExpressions.Regex.IsMatch(name,"^ProjectHub\\.SshMaintenance\\.[a-f0-9]{32}$"),"VALIDATION_CAPABILITY_REQUIRED");using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)){pipe.Connect(3000);uint pid;Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid));IntPtr parent=OpenProcess(0x101000,false,pid);Check(parent!=IntPtr.Zero);try{VerifyImage(parent,(string)manifest["helper"],(string)manifest["helperSHA256"]);C.Require(WaitForSingleObject(parent,0)==258,"CAPABILITY_PARENT_EXITED");int length=BitConverter.ToInt32(ReadExact(pipe,4,3000),0);C.Require(length>0&&length<=4096,"CAPABILITY_LENGTH_REJECTED");var cap=C.Parse(C.Utf8.GetString(ReadExact(pipe,length,3000)));C.Fields(cap,"version","manifestSHA256","migrationId","ordinal","nonce","expiresAt","pid","created","helperPid","helperCreated");C.Require(C.Num(cap,"version",1,1)==1&&C.Str(cap,"manifestSHA256",64)==C.Binding(manifest)&&C.Str(cap,"migrationId",36)==(string)manifest["migrationId"]&&C.Num(cap,"ordinal",1,2)==ordinal,"CAPABILITY_BINDING_REJECTED");C.Require(System.Text.RegularExpressions.Regex.IsMatch(C.Str(cap,"nonce",64),"^[a-f0-9]{64}$"),"CAPABILITY_NONCE_REJECTED");int expires=C.Num(cap,"expiresAt",1,Int32.MaxValue);C.Require(expires>HubSshMaintenanceState.Now()&&expires<=HubSshMaintenanceState.Now()+30&&C.Num(cap,"pid",1,Int32.MaxValue)==(int)GetCurrentProcessId()&&C.Str(cap,"created",32)==Created(GetCurrentProcess()).ToString(System.Globalization.CultureInfo.InvariantCulture)&&C.Num(cap,"helperPid",1,Int32.MaxValue)==(int)pid&&C.Str(cap,"helperCreated",32)==Created(parent).ToString(System.Globalization.CultureInfo.InvariantCulture),"CAPABILITY_IDENTITY_REJECTED");C.Require(WaitForSingleObject(parent,0)==258,"CAPABILITY_PARENT_EXITED");}finally{CloseHandle(parent);}}}
  public void Dispose(){if(job!=IntPtr.Zero){TerminateJobObject(job,125);try{EmptyJob();}catch{}}if(pipe!=null)try{pipe.Dispose();}catch{}foreach(IDisposable d in new IDisposable[]{input,output,error,captured})if(d!=null)try{d.Dispose();}catch{}if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero){TerminateProcess(child.process,125);CloseHandle(child.process);}if(job!=IntPtr.Zero)CloseHandle(job);}
}
