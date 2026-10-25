// Fixed, synthetic W0 cases. Compiled with claude-lpac-probe.cs/pinned-root.cs.
// This partial never creates profiles, accepts commands, calls a vendor CLI,
// changes machine policy, or changes provider readiness.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

partial class HubClaudeLpacProbe {
  [StructLayout(LayoutKind.Sequential)] struct CompletionAssociation { public IntPtr Key, Port; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr value, uint milliseconds);
  [DllImport("kernel32.dll", EntryPoint="SetInformationJobObject", SetLastError=true)] static extern bool SetCompletionPort(IntPtr job, int kind, ref CompletionAssociation info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint length);

  static readonly string[] SuiteNames = new string[] { "functional", "brokers", "control", "tree-stop", "tree-eof", "memory", "process", "cpu", "wall", "stdout", "stderr" };
  readonly Dictionary<string, SortedDictionary<string, object>> suiteRows = new Dictionary<string, SortedDictionary<string, object>>(StringComparer.Ordinal);
  bool suiteComplete, suiteCleanupUnknown, suiteNetworkProbed;
  int suiteRoots=1, suiteReservedAttempts=1, suiteReservedSuccesses=1;
  int suiteObservedRootStarts=1, suiteObservedChildStarts;

  object[] GetSuiteCases() {
    List<object> rows = new List<object>();
    rows.Add(new { name="identity", status=bootstrapPassed?"pass":"not-measured" });
    foreach(string name in SuiteNames) {
      SortedDictionary<string, object> row;
      rows.Add(suiteRows.TryGetValue(name,out row) ? (object)row : new { name=name, status="not-measured", code="NOT_STARTED" });
    }
    rows.Add(new { name="claude-static-identity", status="not-measured", code="SEPARATE_STATIC_GATE" });
    return rows.ToArray();
  }
  SortedDictionary<string,object> CaseRow(string name) {
    SortedDictionary<string,object> row=new SortedDictionary<string,object>(StringComparer.Ordinal);
    row["name"]=name;row["status"]="not-measured";row["code"]="STARTED";suiteRows.Add(name,row);return row;
  }
  void ReserveCase(string name,int worstStarts) {
    Need(Array.IndexOf(SuiteNames,name)>=0&&!suiteRows.ContainsKey(name),"SUITE_CASE_REJECTED");
    Need(total.ElapsedMilliseconds<300000,"SUITE_TIME_RESERVE_EXHAUSTED");
    Need(suiteRoots+1<=12&&suiteReservedAttempts+worstStarts<=48&&suiteReservedSuccesses+worstStarts<=32,"SUITE_START_BUDGET_EXHAUSTED");
    suiteRoots++;suiteReservedAttempts+=worstStarts;suiteReservedSuccesses+=worstStarts;
    Record("case-reserved","case",name,"rootReservations",suiteRoots,"attemptReservations",suiteReservedAttempts,"successReservations",suiteReservedSuccesses);
    CaseRow(name);
  }
  static bool IsDigits(string value) {
    if(String.IsNullOrEmpty(value)||value.Length>10)return false;
    foreach(char c in value)if(c<'0'||c>'9')return false;return true;
  }
  static uint PidValue(string value) { uint pid;Need(IsDigits(value)&&UInt32.TryParse(value,NumberStyles.None,CultureInfo.InvariantCulture,out pid)&&pid>0,"CHILD_PID_REJECTED");return UInt32.Parse(value,CultureInfo.InvariantCulture); }
  static bool HasEvent(CaseRun run,string source,params string[] fields) {
    foreach(string[] row in run.Events) {
      if(row[3]!=source||row.Length!=fields.Length+4)continue;
      bool same=true;for(int i=0;i<fields.Length;i++)if(row[i+4]!=fields[i])same=false;
      if(same)return true;
    }
    return false;
  }
  static void RequireEvidence(bool evidence,string code) { Need(evidence,"CASE_NOT_MEASURED_"+code); }

  sealed class SuiteCapture {
    readonly object sync=new object();readonly Queue<string> lines=new Queue<string>();
    public volatile bool Failed,Exceeded,Completed;public Thread Worker;public long Bytes;
    readonly bool parseLines,rawAfterFirstLine;
    public SuiteCapture(bool parse,bool rawTail){parseLines=parse;rawAfterFirstLine=rawTail;}
    public void Start(IntPtr handle) {
      Worker=new Thread(delegate(){
        try {
          using(FileStream stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read)) {
            byte[] chunk=new byte[4096];MemoryStream line=new MemoryStream();bool first=true;int n;
            while((n=stream.Read(chunk,0,chunk.Length))>0) {
              long count=Interlocked.Add(ref Bytes,n);
              if(count>MaxOutput){Exceeded=true;break;}
              if(!parseLines)continue;
              for(int i=0;i<n;i++) {
                if(rawAfterFirstLine&&!first)continue;
                byte c=chunk[i];
                if(c==10) {
                  string value=Utf8.GetString(line.ToArray());line.SetLength(0);first=false;
                  lock(sync){if(lines.Count>=256)throw new InvalidDataException();lines.Enqueue(value);}
                } else {if(c==0||c==13||line.Length>=2048)throw new InvalidDataException();line.WriteByte(c);}
              }
            }
            if(!Exceeded&&parseLines&&line.Length!=0)throw new InvalidDataException();
          }
        } catch { Failed=true; }
        finally {Completed=true;}
      });Worker.IsBackground=true;Worker.Start();
    }
    public string Next(){lock(sync){return lines.Count==0?null:lines.Dequeue();}}
  }

  sealed class Accounting {public long User;public uint Total,Active,Terminated;}
  static Accounting ReadAccounting(IntPtr job) {
    IntPtr memory=Marshal.AllocHGlobal(48);
    try {Win(QueryInformationJobObject(job,1,memory,48,IntPtr.Zero),"SUITE_JOB_ACCOUNTING_FAILED");return new Accounting {User=Marshal.ReadInt64(memory),Total=unchecked((uint)Marshal.ReadInt32(memory,36)),Active=unchecked((uint)Marshal.ReadInt32(memory,40)),Terminated=unchecked((uint)Marshal.ReadInt32(memory,44))};}
    finally {Marshal.FreeHGlobal(memory);}
  }

  sealed class CaseRun : IDisposable {
    public readonly HubClaudeLpacProbe Owner;public readonly string Name;public readonly int MaximumChildren;
    public IntPtr Job,Port;public PI Process;public FileStream Input;
    public SuiteCapture Output,Error;public readonly Stopwatch Wall=new Stopwatch();
    public readonly List<string[]> Events=new List<string[]>();
    public readonly Dictionary<uint,IntPtr> Children=new Dictionary<uint,IntPtr>();
    public readonly Dictionary<uint,string> Pending=new Dictionary<uint,string>();
    public readonly List<uint> Messages=new List<uint>();
    public readonly List<string> BrokerAttempts=new List<string>(),PendingBrokers=new List<string>();
    public bool BrokerMayHaveRun,BrokerOutcomeKnown;
    public HeldFile Executable;public bool Started,Closed,Empty,ControllerStopped,InputClosed,SawEight,JobTimeSignaled;
    public string StopReason;public uint ExitCode;public uint PeakActive;public Accounting LastAccounting;
    public readonly Stopwatch StopWindow=new Stopwatch();public long StopAtMilliseconds=-1;
    public int SpawnAttempts,Spawned;int messageCount;
    public CaseRun(HubClaudeLpacProbe owner,string name,int maximumChildren){Owner=owner;Name=name;MaximumChildren=maximumChildren;}
    public void Send(string text) {Need(Input!=null&&!InputClosed,"CASE_INPUT_CLOSED");byte[] bytes=Utf8.GetBytes(text);Need(bytes.Length<=256,"CASE_INPUT_BOUND");Input.Write(bytes,0,bytes.Length);Input.Flush();}
    public void BeginStopWindow(){if(!StopWindow.IsRunning){StopAtMilliseconds=Wall.ElapsedMilliseconds;StopWindow.Start();}}
    public int StopRemaining(){return Math.Max(0,5000-(int)Math.Min(5000,StopWindow.ElapsedMilliseconds));}
    public bool WaitEmptyWithinStopWindow(){return ReadAccounting(Job).Active==0||StopRemaining()>0&&Owner.EmptyJob(Job,StopRemaining());}
    public void CloseInput(){BeginStopWindow();if(Input!=null&&!InputClosed){InputClosed=true;Input.Dispose();Input=null;}}
    public void DrainMessages() {
      for(int i=0;i<128;i++) {
        uint message;UIntPtr key;IntPtr value;
        if(!GetQueuedCompletionStatus(Port,out message,out key,out value,0)) {int error=Marshal.GetLastWin32Error();Need(error==258,"CASE_JOB_NOTIFICATION_FAILED",error);break;}
        Need(key.ToUInt64()==1&&message>=1&&message<=13&&++messageCount<=256,"CASE_JOB_NOTIFICATION_REJECTED");if(!Messages.Contains(message))Messages.Add(message);
      }
      LastAccounting=ReadAccounting(Job);PeakActive=Math.Max(PeakActive,LastAccounting.Active);if(LastAccounting.Active==8)SawEight=true;
      uint signal=WaitForSingleObject(Job,0);Need(signal==0||signal==258,"CASE_JOB_WAIT_FAILED");if(signal==0)JobTimeSignaled=true;
    }
    public bool Exited(){uint wait=WaitForSingleObject(Process.Process,0);Need(wait==0||wait==258,"CASE_PROCESS_WAIT_FAILED");if(wait!=0)return false;Win(GetExitCodeProcess(Process.Process,out ExitCode),"CASE_EXIT_QUERY_FAILED");return true;}
    public void Stop(string reason){if(ControllerStopped)return;BeginStopWindow();ControllerStopped=true;StopReason=reason;Win(TerminateJobObject(Job,125),"CASE_STOP_FAILED");}
    public void Dispose() {
      if(Closed)return;Closed=true;
      try {
        BeginStopWindow();CloseInput();
        if(Job!=IntPtr.Zero) {
          bool terminated=TerminateJobObject(Job,125);
          Empty=(!Started||terminated)&&WaitEmptyWithinStopWindow();
          if(Process.Process!=IntPtr.Zero&&WaitForSingleObject(Process.Process,(uint)StopRemaining())!=0)Empty=false;
          foreach(IntPtr handle in Children.Values)if(WaitForSingleObject(handle,(uint)StopRemaining())!=0)Empty=false;
        } else Empty=!Started;
        if(Output!=null&&Output.Worker!=null&&!Output.Worker.Join(StopRemaining()))Empty=false;
        if(Error!=null&&Error.Worker!=null&&!Error.Worker.Join(StopRemaining()))Empty=false;
      } catch {Empty=false;}
      finally {
        if(!Empty||BrokerMayHaveRun&&(!BrokerOutcomeKnown||PendingBrokers.Count!=0))Owner.suiteCleanupUnknown=true;
        foreach(IntPtr handle in Children.Values)CloseHandle(handle);Children.Clear();
        if(Process.Thread!=IntPtr.Zero)CloseHandle(Process.Thread);
        if(Process.Process!=IntPtr.Zero)CloseHandle(Process.Process);
        if(Job!=IntPtr.Zero)CloseHandle(Job);if(Port!=IntPtr.Zero)CloseHandle(Port);
        if(Executable!=null)Executable.Dispose();
        if(Owner.ownerContext)try{Owner.Record("case-job-stopped","case",Name,"empty",Empty,"brokerOutcomeKnown",!BrokerMayHaveRun||BrokerOutcomeKnown,"pendingBrokerRoutes",PendingBrokers.ToArray(),"stopObservationMs",StopWindow.ElapsedMilliseconds);}catch{Owner.suiteCleanupUnknown=true;}
      }
    }
  }

  CaseRun StartCase(string name,int maxChildren,string suffix) {
    CaseRun run=new CaseRun(this,name,maxChildren);IntPtr attrs=IntPtr.Zero,list=IntPtr.Zero,caps=IntPtr.Zero,policy=IntPtr.Zero,environment=IntPtr.Zero;IntPtr[] pipes=new IntPtr[6];bool initialized=false;
    try {
      foreach(HubPinnedRoot pin in pins)pin.Verify();if(profilePin!=null)profilePin.Verify();CheckBudget();
      run.Executable=new HeldFile(fixtureFile);Need(Digest(run.Executable.Stream)==fixtureHash,"FIXTURE_BYTES_CHANGED");
      run.Job=CreateJobObject(IntPtr.Zero,IntPtr.Zero);Win(run.Job!=IntPtr.Zero,"CASE_JOB_CREATE_FAILED");
      XL limits=new XL();limits.Basic.Flags=JobFlags;limits.Basic.Active=8;limits.Basic.JobTime=50000000;limits.JobMemory=new UIntPtr(512U*1024U*1024U);
      Win(SetInformationJobObject(run.Job,9,ref limits,(uint)Marshal.SizeOf(typeof(XL))),"CASE_JOB_LIMIT_SET_FAILED");
      IntPtr readback=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(XL)));
      try {Win(QueryInformationJobObject(run.Job,9,readback,(uint)Marshal.SizeOf(typeof(XL)),IntPtr.Zero),"CASE_JOB_LIMIT_QUERY_FAILED");XL observed=(XL)Marshal.PtrToStructure(readback,typeof(XL));Need(observed.Basic.Flags==JobFlags&&observed.Basic.Active==8&&observed.Basic.JobTime==50000000&&observed.JobMemory.ToUInt64()==536870912,"CASE_JOB_LIMIT_MISMATCH");}
      finally {Marshal.FreeHGlobal(readback);}
      run.Port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,UIntPtr.Zero,1);Win(run.Port!=IntPtr.Zero,"CASE_COMPLETION_PORT_FAILED");
      CompletionAssociation association=new CompletionAssociation {Key=new IntPtr(1),Port=run.Port};Win(SetCompletionPort(run.Job,7,ref association,(uint)Marshal.SizeOf(typeof(CompletionAssociation))),"CASE_COMPLETION_ASSOCIATION_FAILED");
      SA security=new SA();security.Size=Marshal.SizeOf(typeof(SA));security.Inherit=1;
      Win(CreatePipe(out pipes[0],out pipes[1],ref security,4096),"CASE_PIPE_FAILED");Win(CreatePipe(out pipes[2],out pipes[3],ref security,4096),"CASE_PIPE_FAILED");Win(CreatePipe(out pipes[4],out pipes[5],ref security,4096),"CASE_PIPE_FAILED");
      foreach(int at in new int[]{1,2,4})Win(SetHandleInformation(pipes[at],1,0),"CASE_PIPE_INHERITANCE_FAILED");
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref size);Need(size.ToInt64()>0&&size.ToInt64()<65536,"CASE_ATTRIBUTE_SIZE_INVALID");attrs=Marshal.AllocHGlobal(size);Win(InitializeProcThreadAttributeList(attrs,3,0,ref size),"CASE_ATTRIBUTES_FAILED");initialized=true;
      list=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(list,pipes[0]);Marshal.WriteIntPtr(list,IntPtr.Size,pipes[3]);Marshal.WriteIntPtr(list,IntPtr.Size*2,pipes[5]);Win(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),list,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"CASE_HANDLE_ATTRIBUTE_FAILED");
      SC capabilities=new SC();capabilities.Sid=expectedSid;caps=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SC)));Marshal.StructureToPtr(capabilities,caps,false);Win(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf(typeof(SC))),IntPtr.Zero,IntPtr.Zero),"CASE_CAPABILITIES_FAILED");
      policy=Marshal.AllocHGlobal(4);Marshal.WriteInt32(policy,1);Win(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000f),policy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero),"CASE_LPAC_FAILED");
      SIX startup=new SIX();startup.Info.Size=Marshal.SizeOf(typeof(SIX));startup.Info.Flags=0x100;startup.Info.Input=pipes[0];startup.Info.Output=pipes[3];startup.Info.Error=pipes[5];startup.Attributes=attrs;environment=EnvironmentBlock();
      Win(CreateProcess(fixtureFile,new StringBuilder(Quote(fixtureFile)),IntPtr.Zero,IntPtr.Zero,true,0x08080404,environment,Path.Combine(root,"task"),ref startup,out run.Process),"CASE_CREATE_FAILED");run.Started=true;suiteObservedRootStarts++;
      try {Win(AssignProcessToJobObject(run.Job,run.Process.Process),"CASE_JOB_ASSIGN_FAILED");}catch{TerminateProcess(run.Process.Process,125);throw;}
      foreach(int at in new int[]{0,3,5}){CloseHandle(pipes[at]);pipes[at]=IntPtr.Zero;}
      SortedDictionary<string,object> token=VerifyToken(run.Process.Process,run.Job);Record("case-boundary-verified","case",name,"pid",run.Process.Pid,"token",token);
      run.Input=new FileStream(new SafeFileHandle(pipes[1],true),FileAccess.Write);pipes[1]=IntPtr.Zero;
      run.Output=new SuiteCapture(true,name=="stdout");run.Output.Start(pipes[2]);pipes[2]=IntPtr.Zero;
      run.Error=new SuiteCapture(false,false);run.Error.Start(pipes[4]);pipes[4]=IntPtr.Zero;
      run.Wall.Start();run.BrokerMayHaveRun=name=="brokers";
      uint resumed=ResumeThread(run.Process.Thread);if(resumed==0xffffffff)run.BrokerMayHaveRun=false;
      Win(resumed!=0xffffffff,"CASE_RESUME_FAILED");
      run.Send("HUB-LPAC-W0\t1\t"+nonce+"\t"+name+suffix+"\n");return run;
    } catch {run.Dispose();throw;}
    finally {foreach(IntPtr handle in pipes)if(handle!=IntPtr.Zero)CloseHandle(handle);if(attrs!=IntPtr.Zero){if(initialized)DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}foreach(IntPtr memory in new IntPtr[]{list,caps,policy,environment})if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);}
  }

  bool AllowedSource(string name,string source) {
    if(source==name)return true;
    if(name=="functional")return source=="functional-1"||source=="functional-2"||source=="functional-3";
    if(name=="tree-stop"||name=="tree-eof")return source==name+"-1"||source==name+"-2";
    return name=="process"&&source=="hold";
  }
  bool AllowedSpawn(string name,string source,string child) {
    if(name=="functional")return source=="functional"&&child=="functional-1"||source=="functional-1"&&child=="functional-2"||source=="functional-2"&&child=="functional-3";
    if(name=="tree-stop"||name=="tree-eof")return source==name&&child==name+"-1"||source==name+"-1"&&child==name+"-2";
    if(name=="process")return source=="process"&&child=="hold";
    return name=="brokers"&&source=="brokers"&&(child=="breakaway"||child=="wmi"||child=="com-shell");
  }
  void VerifyChild(CaseRun run,uint pid,string source) {
    Need(pid!=run.Process.Pid&&run.Pending.ContainsKey(pid)&&run.Pending[pid]==source&&!run.Children.ContainsKey(pid),"CHILD_IDENTITY_REJECTED");
    IntPtr handle=OpenProcess(0x101000,false,pid);Win(handle!=IntPtr.Zero,"CHILD_OPEN_FAILED");
    try {
      Need(GetProcessId(handle)==pid&&WaitForSingleObject(handle,0)==258,"CHILD_ALREADY_EXITED");
      uint length=32768;StringBuilder image=new StringBuilder((int)length);Win(QueryFullProcessImageName(handle,0,image,ref length),"CHILD_IMAGE_QUERY_FAILED");Need(String.Equals(image.ToString(),fixtureFile,StringComparison.OrdinalIgnoreCase),"CHILD_IMAGE_MISMATCH");
      SortedDictionary<string,object> token=VerifyToken(handle,run.Job);run.DrainMessages();
      run.Children.Add(pid,handle);handle=IntPtr.Zero;
      Record("child-boundary-verified","case",run.Name,"fixtureVerb",source,"pid",pid,"token",token);
      run.Send("HUB-LPAC-W0\t1\t"+nonce+"\tack\t"+pid.ToString(CultureInfo.InvariantCulture)+"\n");
    } finally {if(handle!=IntPtr.Zero)CloseHandle(handle);}
  }
  void Pump(CaseRun run) {
    Need(!run.Output.Failed&&!run.Error.Failed,"CASE_OUTPUT_INVALID");string line;
    while((line=run.Output.Next())!=null) {
      string[] fields=line.Split('\t');Need(fields.Length>=5&&fields.Length<=10&&fields[0]=="HUB-LPAC-W0"&&fields[1]=="1"&&fields[2]==nonce&&AllowedSource(run.Name,fields[3]),"CASE_PROTOCOL_REJECTED");
      foreach(string field in fields){Need(field.Length<=128,"CASE_PROTOCOL_REJECTED");foreach(char c in field)Need(c>=32&&c<=126,"CASE_PROTOCOL_REJECTED");}
      Need(run.Events.Count<256,"CASE_EVENT_LIMIT");run.Events.Add(fields);
      string kind=fields[4];
      if(kind=="spawn-attempt") {
        Need(fields.Length==6&&AllowedSpawn(run.Name,fields[3],fields[5]),"CASE_SPAWN_REJECTED");
        if(run.Name=="brokers"){Need(!run.BrokerAttempts.Contains(fields[5]),"BROKER_DUPLICATE_ATTEMPT");run.BrokerAttempts.Add(fields[5]);run.PendingBrokers.Add(fields[5]);}
        run.SpawnAttempts++;Need(run.SpawnAttempts<=(run.Name=="process"?8:run.Name=="brokers"?3:run.MaximumChildren),"CASE_START_BUDGET_EXCEEDED");
      }
      else if(kind=="spawned") {
        Need(fields.Length==7&&AllowedSpawn(run.Name,fields[3],fields[5])&&run.Spawned<run.MaximumChildren&&run.Spawned<run.SpawnAttempts,"CASE_SPAWN_REJECTED");uint pid=PidValue(fields[6]);Need(!run.Pending.ContainsKey(pid),"CASE_PID_REUSE");run.Pending.Add(pid,fields[5]);run.Spawned++;suiteObservedChildStarts++;
      } else if(kind=="await-owner") {Need(fields.Length==6,"CASE_ACK_REJECTED");VerifyChild(run,PidValue(fields[5]),fields[3]);}
      else if(kind=="file") {Need(fields.Length==9,"CASE_PROTOCOL_REJECTED");if(fields[7]=="allowed-error"||fields[7]=="allowed"&&!(fields[5]=="task"||fields[5]=="tmp"||fields[5]=="runtime"&&fields[6]=="read"))throw new Rejected("BOUNDARY_FILE_ALLOWED",0);}
      else if(kind=="network") {Need(fields.Length==8,"CASE_PROTOCOL_REJECTED");if(fields[6]=="allowed"||fields[6]=="allowed-error")throw new Rejected("BOUNDARY_NETWORK_ALLOWED",0);}
      else if(kind=="broker") {
        Need(fields.Length==8&&run.Name=="brokers"&&fields[3]=="brokers"&&run.PendingBrokers.Contains(fields[5]),"CASE_PROTOCOL_REJECTED");
        if(fields[6]=="deny"&&BrokerDenied(fields[5],fields[7]))run.PendingBrokers.Remove(fields[5]);
        if(fields[6]=="allowed"||fields[6]=="allowed-suspended"||fields[5]=="com-shell"&&fields[7]=="no-pid"){suiteCleanupUnknown=true;throw new Rejected("BOUNDARY_EXTERNAL_PROCESS_UNKNOWN",0);}
      } else Need(kind=="attempt"||kind=="load-enter"||kind=="load-finished"||kind=="functional"||kind=="eof"||kind=="tree"||kind=="brokers"||kind=="quota-observation"||kind=="error"||kind=="input"||kind=="child-output"||kind=="breakaway-cleanup","CASE_EVENT_REJECTED");
    }
    run.DrainMessages();
    Need(total.ElapsedMilliseconds<360000,"SUITE_WALL_LIMIT");
  }

  sealed class OwnedListeners : IDisposable {
    public Socket V4,V6;public int Port4,Port6;
    public OwnedListeners(string nonce) {
      try {V4=Bind(false);V6=Bind(true);Port4=((IPEndPoint)V4.LocalEndPoint).Port;Port6=((IPEndPoint)V6.LocalEndPoint).Port;Positive(V4,false,Port4,nonce);Positive(V6,true,Port6,nonce);}
      catch {Dispose();throw;}
    }
    static Socket Bind(bool ipv6){Socket socket=new Socket(ipv6?AddressFamily.InterNetworkV6:AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp);try{if(ipv6)socket.DualMode=false;socket.Bind(new IPEndPoint(ipv6?IPAddress.IPv6Loopback:IPAddress.Loopback,0));socket.Listen(8);return socket;}catch{socket.Dispose();throw;}}
    static void Positive(Socket listener,bool ipv6,int port,string nonce) {
      using(Socket client=new Socket(ipv6?AddressFamily.InterNetworkV6:AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp)) {
        IAsyncResult connect=client.BeginConnect(ipv6?IPAddress.IPv6Loopback:IPAddress.Loopback,port,null,null);using(WaitHandle wait=connect.AsyncWaitHandle)Need(wait.WaitOne(2000),"LOOPBACK_CONTROL_TIMEOUT");client.EndConnect(connect);
        Need(listener.Poll(2000000,SelectMode.SelectRead),"LOOPBACK_CONTROL_NOT_ACCEPTED");
        using(Socket accepted=listener.Accept()) {byte[] expected=Encoding.ASCII.GetBytes(nonce+"\tcontrol\n");client.SendTimeout=1000;accepted.ReceiveTimeout=1000;int sent=0;while(sent<expected.Length)sent+=client.Send(expected,sent,expected.Length-sent,SocketFlags.None);byte[] actual=new byte[expected.Length];int read=0;while(read<actual.Length){int n=accepted.Receive(actual,read,actual.Length-read,SocketFlags.None);Need(n>0,"LOOPBACK_CONTROL_TRUNCATED");read+=n;}for(int i=0;i<actual.Length;i++)Need(actual[i]==expected[i],"LOOPBACK_CONTROL_MISMATCH");}
      }
    }
    public void CheckDenied(){Need(!V4.Poll(0,SelectMode.SelectRead)&&!V6.Poll(0,SelectMode.SelectRead),"BOUNDARY_LOOPBACK_ACCEPTED");}
    public void Dispose(){if(V4!=null){V4.Dispose();V4=null;}if(V6!=null){V6.Dispose();V6=null;}}
  }
  readonly Dictionary<string,string> markerIdentities=new Dictionary<string,string>(StringComparer.Ordinal);
  void PrepareMarkers() {
    foreach(string folder in new string[]{"controller","runtime","outside-canary","other-task","fake-auth"}) {
      string path=Path.Combine(Path.Combine(root,folder),"marker.txt");Need(Absent(path),"MARKER_ALREADY_EXISTS");byte[] expected=Encoding.ASCII.GetBytes("HUB-LPAC-W0:"+nonce+":"+folder+"\n");
      using(FileStream stream=new FileStream(path,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None)) {stream.Write(expected,0,expected.Length);stream.Flush(true);stream.Position=0;for(int i=0;i<expected.Length;i++)Need(stream.ReadByte()==expected[i],"MARKER_CONTROL_MISMATCH");Need(stream.ReadByte()==-1,"MARKER_CONTROL_MISMATCH");}
      SetAcl(path,folder=="runtime"?"0x1200a9":null,false,false);
      using(HeldFile file=new HeldFile(path)){Need(file.Stream.Length==expected.Length,"MARKER_CONTROL_MISMATCH");markerIdentities.Add(folder,file.Identity);}
    }
    Record("marker-controls-verified","count",5,"ownerReadWrite",true);
  }
  void VerifyMarkers() {
    foreach(KeyValuePair<string,string> marker in markerIdentities) {
      using(HeldFile file=new HeldFile(Path.Combine(Path.Combine(root,marker.Key),"marker.txt"))) {
        Need(file.Identity==marker.Value,"MARKER_IDENTITY_CHANGED");byte[] expected=Encoding.ASCII.GetBytes("HUB-LPAC-W0:"+nonce+":"+marker.Key+"\n");Need(file.Stream.Length==expected.Length,"MARKER_BYTES_CHANGED");foreach(byte b in expected)Need(file.Stream.ReadByte()==b,"MARKER_BYTES_CHANGED");
      }
    }
  }
  void VerifyPositiveFiles() {
    foreach(string folder in new string[]{"task","tmp"})for(int depth=0;depth<4;depth++)using(HeldFile file=new HeldFile(Path.Combine(Path.Combine(root,folder),"w0-d"+depth.ToString(CultureInfo.InvariantCulture)+".bin"))) {
      Need(file.Stream.Length==4096,"TASK_BYTES_MISMATCH");for(int i=0;i<4096;i++)Need(file.Stream.ReadByte()==i%251,"TASK_BYTES_MISMATCH");
    }
  }

  static object InvokeFixed(object target,string method,object[] arguments){return target.GetType().InvokeMember(method,BindingFlags.InvokeMethod,null,target,arguments,CultureInfo.InvariantCulture);}
  static void ReleaseFixed(object value){if(value!=null&&Marshal.IsComObject(value))Marshal.FinalReleaseComObject(value);}
  static void ActivateBrokerControls() {
    object locator=null,services=null,processClass=null,shell=null;
    try {
      locator=Activator.CreateInstance(Type.GetTypeFromProgID("WbemScripting.SWbemLocator",true));services=InvokeFixed(locator,"ConnectServer",new object[]{".","root\\cimv2"});processClass=InvokeFixed(services,"Get",new object[]{"Win32_Process"});
      shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application",true));Need(locator!=null&&services!=null&&processClass!=null&&shell!=null,"BROKER_CONTROL_UNAVAILABLE");
    } finally {ReleaseFixed(shell);ReleaseFixed(processClass);ReleaseFixed(services);ReleaseFixed(locator);}
  }
  void BrokerPositiveControls() {
    bool completed=false;Exception failure=null;
    Thread worker=new Thread(delegate(){try{ActivateBrokerControls();completed=true;}catch(Exception error){failure=error;}});
    worker.IsBackground=true;worker.Start();
    RequireEvidence(worker.Join(10000)&&completed&&failure==null,"BROKER_POSITIVE_CONTROL");
    Record("broker-controls-verified","wmiActivationAndClass",true,"shellActivation",true,"ownerProcessCreateCalled",false);
  }
  bool AllTreeReady(CaseRun run) {
    return run.Children.Count==2&&HasEvent(run,run.Name,"load-enter","tree","0")&&HasEvent(run,run.Name+"-1","load-enter","tree","1")&&HasEvent(run,run.Name+"-2","load-enter","tree","2");
  }
  void ObserveControl(CaseRun control) {
    if(control==null)return;Pump(control);Need(control.Wall.ElapsedMilliseconds<20000&&!control.Exited()&&!control.Output.Exceeded&&!control.Error.Exceeded,"CONTROL_PROCESS_DID_NOT_SURVIVE");
    VerifyToken(control.Process.Process,control.Job);
  }
  void WaitCase(CaseRun run,OwnedListeners listeners,CaseRun control) {
    long nextDisk=0;
    for(;;) {
      Pump(run);ObserveControl(control);if(listeners!=null)listeners.CheckDenied();
      if(run.Output.Exceeded||run.Error.Exceeded) {
        Need(run.Name=="stdout"&&run.Output.Exceeded&&!run.Error.Exceeded||run.Name=="stderr"&&run.Error.Exceeded&&!run.Output.Exceeded,"CASE_UNEXPECTED_OUTPUT_LIMIT");run.Stop("output-"+run.Name);
      }
      if((run.Name=="tree-stop"||run.Name=="tree-eof")&&AllTreeReady(run)&&!run.ControllerStopped&&!run.InputClosed) {
        ObserveControl(control);if(run.Name=="tree-stop")run.Stop("cancel");else run.CloseInput();
      }
      if(run.Wall.ElapsedMilliseconds>=20000&&!run.ControllerStopped) {
        if(run.Name=="wall"&&HasEvent(run,"wall","load-enter","wall","30000"))run.Stop("wall-limit");
        else throw new Rejected("CASE_NOT_MEASURED_WALL_TIMEOUT",0);
      }
      if(run.StopWindow.IsRunning&&run.StopRemaining()==0){suiteCleanupUnknown=true;throw new Rejected("CASE_STOP_OBSERVATION_TIMEOUT",0);}
      if(run.Exited())break;
      // CheckBudget observes bounded metadata with writer-compatible sharing;
      // errors stay unknown. This is a soft budget, never a hard disk quota.
      if(run.Wall.ElapsedMilliseconds>=nextDisk){CheckBudget();nextDisk=run.Wall.ElapsedMilliseconds+1000;}
      Thread.Sleep(10);
    }
    run.BeginStopWindow();
    Need(run.Output.Worker.Join(run.StopRemaining())&&run.Error.Worker.Join(run.StopRemaining()),"CASE_OUTPUT_DRAIN_TIMEOUT");Pump(run);if(listeners!=null)listeners.CheckDenied();ObserveControl(control);
    RequireEvidence(run.WaitEmptyWithinStopWindow(),"JOB_NOT_EMPTY");CheckBudget();
  }
  void Evaluate(CaseRun run) {
    string name=run.Name;
    if(name!="stderr")RequireEvidence(run.Error.Bytes==0,"UNEXPECTED_STDERR");
    if(name=="functional") {
      RequireEvidence(run.ExitCode==0&&run.Children.Count==3&&run.SpawnAttempts==3,"FUNCTIONAL_EXIT");
      for(int depth=0;depth<4;depth++) {
        string source=depth==0?name:name+"-"+depth.ToString(CultureInfo.InvariantCulture);
        RequireEvidence(HasEvent(run,source,"load-enter","functional",depth.ToString(CultureInfo.InvariantCulture))&&HasEvent(run,source,"functional","observed",depth.ToString(CultureInfo.InvariantCulture)),"FUNCTIONAL_DESCENDANT");
        foreach(string folder in new string[]{"task","tmp"})RequireEvidence(HasEvent(run,source,"attempt","file",folder,"create-read-write")&&HasEvent(run,source,"file",folder,"create-read-write","allowed","4096"),"TASK_ACCESS");
        RequireEvidence(HasEvent(run,source,"attempt","file","runtime","read")&&HasEvent(run,source,"file","runtime","read","allowed","0"),"RUNTIME_READ");
        foreach(string folder in new string[]{"runtime","controller","outside-canary","other-task","fake-auth"})foreach(string operation in new string[]{"read","write"}) {
          if(folder=="runtime"&&operation=="read")continue;RequireEvidence(HasEvent(run,source,"attempt","file",folder,operation)&&DeniedEvent(run,source,"file",folder,operation),"FILE_DENIAL");
        }
        foreach(string family in new string[]{"ipv4","ipv6"})RequireEvidence(HasEvent(run,source,"attempt","network",family)&&DeniedEvent(run,source,"network",family,null),"NETWORK_DENIAL");
      }
      VerifyMarkers();VerifyPositiveFiles();
    } else if(name=="brokers") {
      RequireEvidence(run.ExitCode==0&&run.SpawnAttempts==3&&HasEvent(run,name,"brokers","denials-observed"),"BROKER_EXIT");
      foreach(string route in new string[]{"breakaway","wmi","com-shell"})RequireEvidence(DeniedEvent(run,name,"broker",route,null),"BROKER_DENIAL");
      RequireEvidence(run.BrokerAttempts.Count==3&&run.PendingBrokers.Count==0&&run.Output.Completed&&run.Error.Completed&&!run.Output.Failed&&!run.Error.Failed&&!run.Output.Exceeded&&!run.Error.Exceeded,"BROKER_COMPLETE_TRANSCRIPT");
      // Armed before resume: an absent/truncated/unpumped attempt or a blocked
      // external call cannot be mistaken for an empty owned Job. Clear only
      // after every exact route denial and the normal complete case result.
      run.BrokerOutcomeKnown=true;
    } else if(name=="tree-stop")RequireEvidence(run.ControllerStopped&&run.StopReason=="cancel"&&AllTreeReady(run),"CANCEL_TREE");
    else if(name=="tree-eof") {
      RequireEvidence(run.InputClosed&&!run.ControllerStopped&&run.ExitCode==0&&AllTreeReady(run),"EOF_TREE");
      foreach(string source in new string[]{name,name+"-1",name+"-2"})RequireEvidence(HasEvent(run,source,"eof","observed"),"EOF_DESCENDANT");
    } else if(name=="memory")RequireEvidence(!run.ControllerStopped&&run.ExitCode==73&&run.Messages.Contains(10)&&HasEvent(run,name,"load-enter","memory","671088640")&&HasEvent(run,name,"quota-observation","memory","out-of-memory"),"MEMORY_OS_LIMIT");
    else if(name=="process") {
      bool rejection=false;foreach(string[] row in run.Events)if(row.Length==9&&row[3]==name&&row[4]=="quota-observation"&&row[5]=="process"&&row[6]=="win32-error"&&row[8]=="7")rejection=true;
      RequireEvidence(!run.ControllerStopped&&run.ExitCode==73&&run.Messages.Contains(3)&&run.SawEight&&run.Children.Count==7&&run.SpawnAttempts==8&&rejection&&HasEvent(run,name,"load-enter","process","8"),"PROCESS_OS_LIMIT");
    } else if(name=="cpu")RequireEvidence(!run.ControllerStopped&&run.ExitCode!=0&&run.JobTimeSignaled&&run.LastAccounting.User>=50000000&&run.LastAccounting.Terminated>0&&HasEvent(run,name,"load-enter","cpu","15000"),"CPU_OS_LIMIT");
    else if(name=="wall")RequireEvidence(run.ControllerStopped&&run.StopReason=="wall-limit"&&run.Wall.ElapsedMilliseconds>=20000&&HasEvent(run,name,"load-enter","wall","30000"),"WALL_LIMIT");
    else if(name=="stdout"||name=="stderr")RequireEvidence(run.ControllerStopped&&run.StopReason=="output-"+name&&HasEvent(run,name,"load-enter",name,"1048576")&&(name=="stdout"?run.Output.Exceeded:run.Error.Exceeded),"OUTPUT_LIMIT");
    else throw new Rejected("CASE_KIND_REJECTED",0);
  }
  static bool DeniedEvent(CaseRun run,string source,string kind,string target,string operation) {
    foreach(string[] row in run.Events) {
      if(row[3]!=source||row[4]!=kind||row[5]!=target)continue;
      int status=operation==null?6:7;
      if(operation!=null&&row[6]!=operation)continue;
      if(row.Length!=status+2||row[status]!="deny")continue;
      string code=row[status+1];
      if(kind=="file"&&(code=="80070005"||code=="5"))return true;
      if(kind=="network"&&code=="10013")return true;
      if(kind=="broker"&&BrokerDenied(target,code))return true;
    }
    return false;
  }
  static bool BrokerDenied(string route,string code) {
    if(route=="breakaway")return code=="5";
    if(route=="wmi")return code=="2"||code=="5"||code=="80070005"||code=="80041003";
    return route=="com-shell"&&(code=="5"||code=="80070005");
  }
  void SaveCaseEvidence(CaseRun run) {
    SortedDictionary<string,object> row=suiteRows[run.Name];row["rootPid"]=run.Process.Pid;row["heldChildren"]=run.Children.Count;row["spawnAttempts"]=run.SpawnAttempts;row["spawnedChildren"]=run.Spawned;row["exitCode"]=run.ExitCode;row["stdoutBytes"]=run.Output.Bytes;row["stderrBytes"]=run.Error.Bytes;row["durationMs"]=run.Wall.ElapsedMilliseconds;row["controllerStop"]=run.StopReason;
    uint[] messages=new uint[run.Messages.Count];run.Messages.CopyTo(messages);Array.Sort(messages);row["jobMessages"]=messages;row["activePeakObserved"]=run.PeakActive;row["activeEightObserved"]=run.SawEight;
    if(run.LastAccounting!=null){row["jobUser100ns"]=run.LastAccounting.User;row["jobLimitTerminations"]=run.LastAccounting.Terminated;}
    row["stopAtMs"]=run.StopAtMilliseconds;row["stopObservationMs"]=run.StopWindow.ElapsedMilliseconds;
    if(run.Name=="brokers"){row["externalOutcomeKnown"]=!run.BrokerMayHaveRun||run.BrokerOutcomeKnown;row["pendingBrokerRoutes"]=run.PendingBrokers.ToArray();}
  }
  void ExecuteCase(string name,int worstStarts,int maxChildren,OwnedListeners listeners,CaseRun control) {
    ReserveCase(name,worstStarts);CaseRun run=null;
    try {
      if(name=="brokers")BrokerPositiveControls();
      string suffix=listeners==null?"":"\t"+listeners.Port4.ToString(CultureInfo.InvariantCulture)+"\t"+listeners.Port6.ToString(CultureInfo.InvariantCulture);
      run=StartCase(name,maxChildren,suffix);WaitCase(run,listeners,control);Evaluate(run);SaveCaseEvidence(run);
      suiteRows[name]["status"]="pass";suiteRows[name]["code"]="OBSERVED";
    } catch(Rejected failure) {suiteRows[name]["status"]=failure.Code.StartsWith("BOUNDARY_",StringComparison.Ordinal)?"fail":"not-measured";suiteRows[name]["code"]=failure.Code;throw;}
    catch {suiteRows[name]["status"]="not-measured";suiteRows[name]["code"]="CASE_OBSERVATION_FAILED";throw;}
    finally {if(run!=null){try{SaveCaseEvidence(run);}catch{}run.Dispose();suiteRows[name]["jobEmpty"]=run.Empty;if(!run.Empty){suiteRows[name]["status"]="fail";suiteRows[name]["code"]="CASE_CLEANUP_UNKNOWN";}}Record("case-result","case",name,"evidence",suiteRows[name]);}
    Need(!suiteCleanupUnknown,"SUITE_CLEANUP_UNKNOWN");
  }
  void RunTreePair() {
    CaseRun control=null;ReserveCase("control",1);
    try {
      control=StartCase("control",0,"");
      while(!HasEvent(control,"control","load-enter","control")){ObserveControl(control);Need(control.Wall.ElapsedMilliseconds<5000,"CONTROL_NOT_READY");Thread.Sleep(10);}
      ExecuteCase("tree-stop",3,2,null,control);ExecuteCase("tree-eof",3,2,null,control);
      ObserveControl(control);control.CloseInput();
      while(!control.Exited()) {Pump(control);if(control.StopRemaining()==0){suiteCleanupUnknown=true;throw new Rejected("CONTROL_EOF_TIMEOUT",0);}Thread.Sleep(10);}
      Need(control.Output.Worker.Join(control.StopRemaining())&&control.Error.Worker.Join(control.StopRemaining()),"CONTROL_OUTPUT_INCOMPLETE");Pump(control);
      RequireEvidence(control.ExitCode==0&&HasEvent(control,"control","eof","observed")&&control.Error.Bytes==0&&control.WaitEmptyWithinStopWindow(),"CONTROL_CLEANUP");
      SaveCaseEvidence(control);suiteRows["control"]["status"]="pass";suiteRows["control"]["code"]="SURVIVED_BOTH_STOP_PATHS";
    } catch(Rejected failure){suiteRows["control"]["status"]="not-measured";suiteRows["control"]["code"]=failure.Code;throw;}
    finally {if(control!=null){control.Dispose();suiteRows["control"]["jobEmpty"]=control.Empty;if(!control.Empty){suiteRows["control"]["status"]="fail";suiteRows["control"]["code"]="CONTROL_CLEANUP_UNKNOWN";}}Record("case-result","case","control","evidence",suiteRows["control"]);}
    Need(!suiteCleanupUnknown,"SUITE_CLEANUP_UNKNOWN");
  }
  void RunSuiteCases() {
    Need(bootstrapPassed&&jobEmpty&&ownerContext,"SUITE_PREREQUISITE_FAILED");bool priorSafe=jobEmpty;jobEmpty=false;stage="probing";
    try {
      Record("suite-manifest","rootsMaximum",12,"successfulStartsMaximum",32,"attemptsMaximum",48,"retries",0);
      PrepareMarkers();
      using(OwnedListeners listeners=new OwnedListeners(nonce)) {suiteNetworkProbed=true;Record("loopback-controls-verified","ipv4",true,"ipv6",true);ExecuteCase("functional",4,3,listeners,null);}
      ExecuteCase("brokers",4,0,null,null);RunTreePair();
      ExecuteCase("memory",1,0,null,null);ExecuteCase("process",9,7,null,null);ExecuteCase("cpu",1,0,null,null);ExecuteCase("wall",1,0,null,null);ExecuteCase("stdout",1,0,null,null);ExecuteCase("stderr",1,0,null,null);
      CheckBudget();suiteComplete=true;
    } finally {
      jobEmpty=priorSafe&&!suiteCleanupUnknown;stage="stopping";
      result["syntheticSuiteComplete"]=suiteComplete;result["networkProbed"]=suiteNetworkProbed;result["reservedCaseRoots"]=suiteRoots;result["reservedStartAttempts"]=suiteReservedAttempts;result["reservedPossibleSuccesses"]=suiteReservedSuccesses;result["observedRootStarts"]=suiteObservedRootStarts;result["observedChildStarts"]=suiteObservedChildStarts;
      Record("suite-stopped","jobEmpty",jobEmpty,"suiteComplete",suiteComplete,"providerReady",false);
    }
  }
}
