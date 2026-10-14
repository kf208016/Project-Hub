// One-session diagnostic transport, cloned from the frozen maintenance transport.
// Credential bytes stay in native helper processes and the SSH password pipe.
// This class controls process lifetime; it does not sandbox remote commands.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public sealed class HubSshR2DiagnosticTransport : IDisposable {
  public sealed class Options {
    public string Ssh, Cwd, Helper, HostFingerprint;
    public string[] Args;
    public byte[] Secret;
    public byte[] FixedInput;
    public bool CaptureOutput;
    public int DeadlineMs, ExpiresAtUnixSeconds;
    public Action<string> EventSink;
  }
  public sealed class Result {
    public int ExitCode=125;
    public bool Authenticated, AskpassSupplied, CleanupVerified;
    public byte[] Output=new byte[0];
  }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] struct SI {
    public int cb; public IntPtr reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags;
    public short show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct XLIMIT { public LIMIT basic;public IO io;public UIntPtr process,job,peakProcess,peakJob; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref XLIMIT info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr buffer,uint size,IntPtr returned);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipe(string name,uint access,uint mode,uint max,uint output,uint input,uint timeout,ref SA attributes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  readonly Options options;
  readonly Result result=new Result();
  readonly object state=new object();
  readonly Stopwatch clock=Stopwatch.StartNew();
  readonly string sid,pipeName,nonce;
  IntPtr job=IntPtr.Zero;
  PI process;
  long sshCreated;
  string sshHash,helperHash;
  FileStream sshPin,helperPin,input,output,error;
  NamedPipeServerStream server;
  Thread passwordThread,outputThread,errorThread,inputThread;
  volatile bool failed,stopping;
  bool hostPinSeen;
  MemoryStream captured=new MemoryStream();

  HubSshR2DiagnosticTransport(Options value) {
    options=value;
    Require(value!=null&&value.Args!=null&&value.Args.Length<=80&&value.Secret!=null&&value.Secret.Length>=1&&value.Secret.Length<=2560,"INPUT_REJECTED");
    Require(value.CaptureOutput&&value.FixedInput!=null&&value.FixedInput.Length>0&&value.FixedInput.Length<=1024*1024+8192,"FIXED_INPUT_REQUIRED");
    Require(value.DeadlineMs>=1000&&value.DeadlineMs<=45000&&value.ExpiresAtUnixSeconds>0,"DEADLINE_REJECTED");
    Require(Absolute(value.Ssh)&&Absolute(value.Helper)&&Absolute(value.Cwd),"PATH_REJECTED");
    Require(value.HostFingerprint!=null&&System.Text.RegularExpressions.Regex.IsMatch(value.HostFingerprint,"^SHA256:[A-Za-z0-9+/]{43}$"),"PIN_REJECTED");
    foreach(string arg in value.Args)Require(arg!=null&&arg.IndexOf('\0')<0&&arg.Length<=8192,"ARGUMENT_REJECTED");
    sid=WindowsIdentity.GetCurrent().User.Value;
    pipeName="ProjectHub.SshVault."+Guid.NewGuid().ToString("N");
    nonce=Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N");
  }
  static bool Absolute(string value) { return value!=null&&value.Length>3&&value.Length<32768&&Char.IsLetter(value[0])&&value[1]==':'&&value[2]=='\\'&&value.IndexOf('\0')<0; }
  static void Require(bool value,string code) { if(!value)throw new InvalidOperationException(code); }
  static void Check(bool value) { if(!value)throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Clear(byte[] bytes) { if(bytes!=null)Array.Clear(bytes,0,bytes.Length); }
  static string Digest(Stream stream) { using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
  static FileStream Pin(string path,out string hash) { FileStream file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);try {hash=Digest(file);file.Position=0;return file;}catch {file.Dispose();throw;} }
  static long Created(IntPtr handle) {long c,e,k,u;Check(GetProcessTimes(handle,out c,out e,out k,out u));return c;}
  static string Image(IntPtr handle) {StringBuilder p=new StringBuilder(32768);uint n=32768;Check(QueryFullProcessImageName(handle,0,p,ref n));return p.ToString();}
  static string Sid(IntPtr handle) {IntPtr token;Check(OpenProcessToken(handle,8,out token));try{using(WindowsIdentity identity=new WindowsIdentity(token))return identity.User.Value;}finally{CloseHandle(token);}}
  static uint Parent(IntPtr handle) {IntPtr buffer=Marshal.AllocHGlobal(IntPtr.Size*6);try{Require(NtQueryInformationProcess(handle,0,buffer,(uint)(IntPtr.Size*6),IntPtr.Zero)==0,"PARENT_UNAVAILABLE");return checked((uint)Marshal.ReadIntPtr(buffer,IntPtr.Size*5).ToInt64());}finally{Marshal.FreeHGlobal(buffer);}}
  static string Quote(string text) {StringBuilder b=new StringBuilder("\"");int slash=0;foreach(char c in text){if(c=='\\'){slash++;continue;}if(c=='\"'){b.Append('\\',slash*2+1);b.Append(c);}else{b.Append('\\',slash);b.Append(c);}slash=0;}b.Append('\\',slash*2);return b.Append('"').ToString();}
  void Emit(string message) { if(options.EventSink!=null)options.EventSink(message); }
  void Fail(string code) {failed=true;try{Emit(code);}catch{} }
  int Remaining() {long elapsed=(clock.ElapsedTicks*1000+Stopwatch.Frequency-1)/Stopwatch.Frequency;long utcTicks=DateTime.UtcNow.Ticks-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).Ticks;long expiry=(long)options.ExpiresAtUnixSeconds*1000-(utcTicks+9999)/10000;return checked((int)Math.Max(0,Math.Min(options.DeadlineMs-elapsed,expiry)));}
  static void ReadExact(Stream stream,byte[] bytes,int count,int timeout) {
    int offset=0;Stopwatch timer=Stopwatch.StartNew();
    while(offset<count){int remaining=timeout-(int)timer.ElapsedMilliseconds;Require(remaining>0,"PIPE_TIMEOUT");IAsyncResult pending=stream.BeginRead(bytes,offset,count-offset,null,null);try{if(!pending.AsyncWaitHandle.WaitOne(remaining)){stream.Dispose();try{stream.EndRead(pending);}catch{}throw new InvalidOperationException("PIPE_TIMEOUT");}int n=stream.EndRead(pending);Require(n>0,"PIPE_EOF");offset+=n;}finally{pending.AsyncWaitHandle.Close();}}
  }
  void CreateSecretPipe() {
    IntPtr descriptor=IntPtr.Zero,handle=IntPtr.Zero;uint size;
    Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;"+sid+")",1,out descriptor,out size));
    try{SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.descriptor=descriptor;
      handle=CreateNamedPipe("\\\\.\\pipe\\"+pipeName,0x40080003,0x8,1,4096,4096,0,ref sa);
      Check(handle!=new IntPtr(-1));
      server=new NamedPipeServerStream(PipeDirection.InOut,true,false,new SafePipeHandle(handle,true));handle=IntPtr.Zero;
    }finally{if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1))CloseHandle(handle);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
  }
  void VerifyClient(uint pid) {
    IntPtr peer=OpenProcess(0x101000,false,pid);Check(peer!=IntPtr.Zero);
    try{
      bool owned;Check(IsProcessInJob(peer,job,out owned));Require(owned&&Sid(peer)==sid,"ASKPASS_PEER_REJECTED");
      string image=Image(peer),hash;using(FileStream file=Pin(image,out hash))Require(String.Equals(image,options.Helper,StringComparison.OrdinalIgnoreCase)&&hash==helperHash,"ASKPASS_IMAGE_REJECTED");
      long childCreated=Created(peer);uint parent=Parent(peer);
      for(int depth=0;depth<4;depth++){
        IntPtr ancestor=OpenProcess(0x101000,false,parent);Check(ancestor!=IntPtr.Zero);
        try{
          long created=Created(ancestor);Check(IsProcessInJob(ancestor,job,out owned));Require(owned&&Sid(ancestor)==sid&&created<=childCreated,"ASKPASS_ANCESTRY_REJECTED");
          string ancestorImage=Image(ancestor),ancestorHash;using(FileStream file=Pin(ancestorImage,out ancestorHash))Require(String.Equals(ancestorImage,options.Ssh,StringComparison.OrdinalIgnoreCase)&&ancestorHash==sshHash,"ASKPASS_ANCESTRY_IMAGE_REJECTED");
          if(parent==process.pid){Require(created==sshCreated&&WaitForSingleObject(process.process,0)==258,"ASKPASS_SSH_EXPIRED");return;}
          childCreated=created;parent=Parent(ancestor);
        }finally{CloseHandle(ancestor);}
      }
      throw new InvalidOperationException("ASKPASS_ANCESTRY_LIMIT");
    }finally{CloseHandle(peer);}
  }
  void SupplyPassword() {
    byte[] request=new byte[64],header=new byte[4];
    try{
      IAsyncResult accept=server.BeginWaitForConnection(null,null);
      try{if(!accept.AsyncWaitHandle.WaitOne(Remaining())){server.Dispose();try{server.EndWaitForConnection(accept);}catch{}throw new InvalidOperationException("ASKPASS_TIMEOUT");}server.EndWaitForConnection(accept);}finally{accept.AsyncWaitHandle.Close();}
      uint pid;Check(GetNamedPipeClientProcessId(server.SafePipeHandle.DangerousGetHandle(),out pid));VerifyClient(pid);
      ReadExact(server,request,64,Math.Min(Remaining(),3000));
      byte[] expected=Encoding.ASCII.GetBytes(nonce);try{int difference=0;for(int i=0;i<64;i++)difference|=request[i]^expected[i];Require(difference==0,"ASKPASS_NONCE_REJECTED");}finally{Clear(expected);}
      VerifyClient(pid);Require(!stopping&&!failed&&Remaining()>6000,"ASKPASS_EXPIRED");
      int length=options.Secret.Length;header[2]=(byte)(length>>8);header[3]=(byte)length;
      server.Write(header,0,4);server.Write(options.Secret,0,length);server.Flush();
      lock(state)result.AskpassSupplied=true;Emit("ASKPASS_SUPPLIED");
    }catch{if(!stopping)Fail("ASKPASS_REJECTED");}
    finally{Clear(request);Clear(header);if(server!=null)server.Dispose();}
  }
  IntPtr EnvironmentBlock() {
    SortedDictionary<string,string> env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    string system=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    env["SystemRoot"]=system;env["WINDIR"]=system;env["PATH"]=Path.GetDirectoryName(options.Ssh)+";"+Path.Combine(system,"System32");
    env["LANG"]="C.UTF-8";env["LC_ALL"]="C.UTF-8";env["SSH_ASKPASS"]=options.Helper;env["SSH_ASKPASS_REQUIRE"]="force";env["DISPLAY"]="project-hub:0";
    env["HUB_SSH_VAULT_PIPE"]=pipeName;env["HUB_SSH_VAULT_NONCE"]=nonce;
    env["HUB_SSH_VAULT_SERVER_PID"]=GetCurrentProcessId().ToString(System.Globalization.CultureInfo.InvariantCulture);
    env["HUB_SSH_VAULT_SERVER_CREATED"]=Created(GetCurrentProcess()).ToString(System.Globalization.CultureInfo.InvariantCulture);
    env["HUB_SSH_VAULT_SERVER_IMAGE"]=helperHash;
    StringBuilder b=new StringBuilder();foreach(KeyValuePair<string,string> pair in env)b.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');b.Append('\0');return Marshal.StringToHGlobalUni(b.ToString());
  }
  void Launch() {
    IntPtr[] handles=new IntPtr[6];IntPtr attributes=IntPtr.Zero,list=IntPtr.Zero,env=IntPtr.Zero;
    try{
      SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.inherit=1;
      Check(CreatePipe(out handles[0],out handles[1],ref sa,0));Check(CreatePipe(out handles[2],out handles[3],ref sa,0));Check(CreatePipe(out handles[4],out handles[5],ref sa,0));
      Check(SetHandleInformation(handles[1],1,0));Check(SetHandleInformation(handles[2],1,0));Check(SetHandleInformation(handles[4],1,0));
      SIX si=new SIX();si.info.cb=Marshal.SizeOf(typeof(SIX));si.info.flags=0x100;si.info.input=handles[0];si.info.output=handles[3];si.info.error=handles[5];
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attributes=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));
      list=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(list,0,handles[0]);Marshal.WriteIntPtr(list,IntPtr.Size,handles[3]);Marshal.WriteIntPtr(list,IntPtr.Size*2,handles[5]);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),list,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));si.attributes=attributes;
      StringBuilder command=new StringBuilder(Quote(options.Ssh));foreach(string argument in options.Args)command.Append(' ').Append(Quote(argument));Require(command.Length<24000,"ARGUMENT_LIMIT");env=EnvironmentBlock();
      Check(CreateProcess(options.Ssh,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,options.Cwd,ref si,out process));
      try{Check(AssignProcessToJobObject(job,process.process));}catch{TerminateProcess(process.process,125);throw;}
      sshCreated=Created(process.process);
      input=new FileStream(new SafeFileHandle(handles[1],true),FileAccess.Write);handles[1]=IntPtr.Zero;
      output=new FileStream(new SafeFileHandle(handles[2],true),FileAccess.Read);handles[2]=IntPtr.Zero;
      error=new FileStream(new SafeFileHandle(handles[4],true),FileAccess.Read);handles[4]=IntPtr.Zero;
      passwordThread=new Thread(SupplyPassword);passwordThread.IsBackground=true;passwordThread.Start();
      outputThread=new Thread(ReadOutput);outputThread.IsBackground=true;outputThread.Start();
      errorThread=new Thread(ReadError);errorThread.IsBackground=true;errorThread.Start();
      inputThread=new Thread(RelayInput);inputThread.IsBackground=true;inputThread.Start();
      Check(ResumeThread(process.thread)!=0xffffffff);Emit("SSH_PID:"+process.pid.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }finally{foreach(IntPtr handle in handles)if(handle!=IntPtr.Zero)CloseHandle(handle);if(attributes!=IntPtr.Zero){DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);}
  }
  void RelayInput() {byte[] bytes=new byte[65536];try{Stream source=new MemoryStream(options.FixedInput??new byte[0],false);for(;;){int n=source.Read(bytes,0,bytes.Length);if(n==0)break;input.Write(bytes,0,n);input.Flush();}}catch{if(!stopping)Fail("SSH_INPUT_FAILED");}finally{Clear(bytes);try{input.Dispose();}catch{}}}
  void ReadOutput() {byte[] bytes=new byte[65536];try{Stream destination=captured;for(;;){int n=output.Read(bytes,0,bytes.Length);if(n==0)break;Require(captured.Length+n<=131072,"SSH_OUTPUT_LIMIT");destination.Write(bytes,0,n);destination.Flush();}}catch{failed=true;if(!stopping)Fail("SSH_OUTPUT_FAILED");}finally{Clear(bytes);}}
  void ParseErrorLine(string line) {
    if(line=="debug1: Server host key: ssh-ed25519 "+options.HostFingerprint){hostPinSeen=true;Emit("SSH_HOST_PIN_MATCHED");}
    if(line.StartsWith("Authenticated to ",StringComparison.Ordinal)&&line.EndsWith(" using \"password\".",StringComparison.Ordinal)){
      Require(hostPinSeen,"SSH_AUTH_WITHOUT_PIN");lock(state)result.Authenticated=true;Emit("SSH_PASSWORD_AUTHENTICATED");
    }
    if(line.IndexOf("Permission denied",StringComparison.Ordinal)>=0)Emit("SSH_PERMISSION_DENIED");
  }
  void ReadError() {byte[] line=new byte[32768];int used=0,total=0;try{for(;;){int value=error.ReadByte();if(value<0){if(used>0)ParseErrorLine(Encoding.UTF8.GetString(line,0,used));break;}Require(++total<=131072,"SSH_STDERR_LIMIT");if(value==10){if(used>0&&line[used-1]==13)used--;ParseErrorLine(Encoding.UTF8.GetString(line,0,used));Array.Clear(line,0,used);used=0;}else{Require(used<line.Length,"SSH_STDERR_LINE_LIMIT");line[used++]=(byte)value;}}}catch{failed=true;if(!stopping)Fail("SSH_DIAGNOSTIC_REJECTED");}finally{Clear(line);}}
  bool EmptyJob(int timeout) {IntPtr memory=Marshal.AllocHGlobal(48);Stopwatch wait=Stopwatch.StartNew();try{while(wait.ElapsedMilliseconds<timeout){Check(QueryInformationJobObject(job,1,memory,48,IntPtr.Zero));if(Marshal.ReadInt32(memory,40)==0)return true;Thread.Sleep(20);}return false;}finally{Marshal.FreeHGlobal(memory);}}
  Result Execute() {
    sshPin=Pin(options.Ssh,out sshHash);helperPin=Pin(options.Helper,out helperHash);
    Require(String.Equals(Image(GetCurrentProcess()),options.Helper,StringComparison.OrdinalIgnoreCase),"BROKER_IMAGE_REJECTED");
    job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);XLIMIT limits=new XLIMIT();limits.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(XLIMIT))));
    CreateSecretPipe();Require(Remaining()>6000,"SSH_DEADLINE");Launch();
    while(!failed&&Remaining()>6000){uint wait=WaitForSingleObject(process.process,50);if(wait==0)break;Require(wait==258,"SSH_WAIT_FAILED");}
    if(Remaining()<=6000){failed=true;Emit("SSH_DEADLINE");}
    uint code;if(!failed&&GetExitCodeProcess(process.process,out code)&&code!=259)result.ExitCode=unchecked((int)code);
    stopping=true;Check(TerminateJobObject(job,125));result.CleanupVerified=EmptyJob(Math.Max(0,Math.Min(1000,options.DeadlineMs-(int)clock.ElapsedMilliseconds)));
    try{server.Dispose();}catch{}try{input.Dispose();}catch{}
    if(outputThread!=null&&!outputThread.Join(Math.Max(0,Math.Min(1000,options.DeadlineMs-(int)clock.ElapsedMilliseconds))))failed=true;
    if(errorThread!=null&&!errorThread.Join(Math.Max(0,Math.Min(1000,options.DeadlineMs-(int)clock.ElapsedMilliseconds))))failed=true;
    if(passwordThread!=null&&!passwordThread.Join(Math.Max(0,Math.Min(1000,options.DeadlineMs-(int)clock.ElapsedMilliseconds))))failed=true;
    if(failed||!result.CleanupVerified)result.ExitCode=125;
    if(options.CaptureOutput)result.Output=captured.ToArray();
    return result;
  }
  public static Result Run(Options value) {using(HubSshR2DiagnosticTransport transport=new HubSshR2DiagnosticTransport(value))return transport.Execute();}
  public void Dispose() {
    stopping=true;
    if(job!=IntPtr.Zero){TerminateJobObject(job,125);try{result.CleanupVerified=EmptyJob(Math.Max(0,Math.Min(1000,options.DeadlineMs-(int)clock.ElapsedMilliseconds)));}catch{result.CleanupVerified=false;}}
    if(server!=null)try{server.Dispose();}catch{}
    foreach(IDisposable item in new IDisposable[]{input,output,error,sshPin,helperPin,captured})if(item!=null)try{item.Dispose();}catch{}
    if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero){TerminateProcess(process.process,125);CloseHandle(process.process);}
    if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}
  }
  public static int Askpass() {
    byte[] secret=null,request=null,header=new byte[4];IntPtr broker=IntPtr.Zero;
    try{
      string name=Environment.GetEnvironmentVariable("HUB_SSH_VAULT_PIPE"),nonce=Environment.GetEnvironmentVariable("HUB_SSH_VAULT_NONCE"),hash=Environment.GetEnvironmentVariable("HUB_SSH_VAULT_SERVER_IMAGE");
      uint expectedPid;long expectedCreated=0;
      Require(name!=null&&System.Text.RegularExpressions.Regex.IsMatch(name,"^ProjectHub\\.SshVault\\.[a-f0-9]{32}$")&&nonce!=null&&System.Text.RegularExpressions.Regex.IsMatch(nonce,"^[a-f0-9]{64}$")&&hash!=null&&System.Text.RegularExpressions.Regex.IsMatch(hash,"^[a-f0-9]{64}$"),"ASKPASS_DESCRIPTOR_REJECTED");
      Require(UInt32.TryParse(Environment.GetEnvironmentVariable("HUB_SSH_VAULT_SERVER_PID"),out expectedPid)&&expectedPid>0&&Int64.TryParse(Environment.GetEnvironmentVariable("HUB_SSH_VAULT_SERVER_CREATED"),out expectedCreated),"ASKPASS_SERVER_REJECTED");
      Require(GetFileType(GetStdHandle(-11))==3,"ASKPASS_OUTPUT_REJECTED");
      using(NamedPipeClientStream pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)){
        pipe.Connect(3000);uint peer;Check(GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out peer));Require(peer==expectedPid,"ASKPASS_SERVER_REJECTED");
        broker=OpenProcess(0x101000,false,peer);Check(broker!=IntPtr.Zero);Require(Created(broker)==expectedCreated&&WaitForSingleObject(broker,0)==258&&Sid(broker)==WindowsIdentity.GetCurrent().User.Value,"ASKPASS_SERVER_REJECTED");
        string serverImage=Image(broker),serverHash;using(FileStream pinned=Pin(serverImage,out serverHash)){
          Require(String.Equals(serverImage,Image(GetCurrentProcess()),StringComparison.OrdinalIgnoreCase)&&serverHash==hash,"ASKPASS_SERVER_IMAGE_REJECTED");
          request=Encoding.ASCII.GetBytes(nonce);pipe.Write(request,0,request.Length);pipe.Flush();ReadExact(pipe,header,4,3000);
          int length=(header[0]<<24)|(header[1]<<16)|(header[2]<<8)|header[3];Require(length>=1&&length<=2560,"ASKPASS_SECRET_LENGTH");secret=new byte[length];ReadExact(pipe,secret,length,3000);
          Require(WaitForSingleObject(broker,0)==258,"ASKPASS_SERVER_EXPIRED");Stream stdout=Console.OpenStandardOutput();stdout.Write(secret,0,secret.Length);stdout.WriteByte(10);stdout.Flush();return 0;
        }
      }
    }catch{return 125;}
    finally{Clear(secret);Clear(request);Clear(header);if(broker!=IntPtr.Zero)CloseHandle(broker);}
  }
}
