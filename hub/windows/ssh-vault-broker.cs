// Owner-only SSH credential orchestration. Secrets never cross the Node boundary.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

class HubSshVaultBroker {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false,true);
  static readonly string Sid = WindowsIdentity.GetCurrent().User.Value;
  static readonly byte[] Entropy = Encoding.ASCII.GetBytes("ProjectHub.WorkerSshPassword.Receipt.v1");
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct FI {public uint Attributes;public FT Creation,Access,Write;public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [StructLayout(LayoutKind.Sequential)] struct SA {public int Size;public IntPtr Descriptor;public int Inherit;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SA sa);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FI info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr s,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Require(bool yes,string code) {if(!yes)throw new InvalidOperationException(code);}
  static string Hash(byte[] b) {using(SHA256 s=SHA256.Create())return BitConverter.ToString(s.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
  static string Self {get{return System.Reflection.Assembly.GetExecutingAssembly().Location;}}
  static void Fields(Dictionary<string,object> d,params string[] names) {Require(d!=null&&d.Count==names.Length,"FIELDS_REJECTED");foreach(string n in names)Require(d.ContainsKey(n),"FIELDS_REJECTED");}
  static string Str(Dictionary<string,object> d,string k,int max) {object v;Require(d.TryGetValue(k,out v)&&v is string,"FIELD_TYPE_REJECTED");string s=(string)v;Require(s.Length>0&&s.Length<=max,"FIELD_BOUND_REJECTED");foreach(char c in s)Require(c>=32&&c!=127,"CONTROL_CHARACTER_REJECTED");Utf8.GetBytes(s);return s;}
  static int Num(Dictionary<string,object> d,string k,int min,int max) {object v;Require(d.TryGetValue(k,out v)&&v is int&&(int)v>=min&&(int)v<=max,"INTEGER_REJECTED");return (int)v;}
  static string QuoteJson(string text) {
    Utf8.GetByteCount(text);StringBuilder b=new StringBuilder("\"");
    foreach(char c in text){switch(c){case '"':b.Append("\\\"");break;case '\\':b.Append("\\\\");break;case '\b':b.Append("\\b");break;case '\f':b.Append("\\f");break;case '\n':b.Append("\\n");break;case '\r':b.Append("\\r");break;case '\t':b.Append("\\t");break;default:if(c<32)b.Append("\\u"+((int)c).ToString("x4"));else b.Append(c);break;}}
    return b.Append('"').ToString();
  }
  static string Canon(object value) {
    Dictionary<string,object> d=value as Dictionary<string,object>;
    if(d!=null){var keys=new List<string>(d.Keys);keys.Sort(StringComparer.Ordinal);var parts=new List<string>();foreach(string k in keys)parts.Add(QuoteJson(k)+":"+Canon(d[k]));return "{"+String.Join(",",parts.ToArray())+"}";}
    if(value is string)return QuoteJson((string)value);
    if(value is bool||value is int||value==null)return Json.Serialize(value);
    throw new InvalidOperationException("JSON_TYPE_REJECTED");
  }
  static Dictionary<string,object> Parse(string s) {
    Require(s!=null&&s.Length<=24000,"REQUEST_BOUND_REJECTED");var d=Json.DeserializeObject(s) as Dictionary<string,object>;
    // Canonical bytes also reject duplicate keys, alternate escapes and ignored data.
    Require(d!=null&&Canon(d)==s,"NONCANONICAL_JSON_REJECTED");return d;
  }
  static string PathCheck(string p) {
    Require(p!=null&&Regex.IsMatch(p,@"^[A-Za-z]:\\")&&p.Length<240&&!p.EndsWith("\\")&&Path.GetFullPath(p)==p,"PATH_REJECTED");
    string current=Path.GetPathRoot(p);
    foreach(string part in p.Substring(current.Length).Split('\\')) {
      Require(part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".")&&!part.EndsWith(" ")&&part.IndexOf(':')<0,"PATH_REJECTED");
      current=Path.Combine(current,part);
      if(File.Exists(current)||Directory.Exists(current))Require((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"REPARSE_REJECTED");
    }return p;
  }
  static FileStream HoldFile(string p,int max) {
    PathCheck(p);FileStream f=new FileStream(p,FileMode.Open,FileAccess.Read,FileShare.Read);
    try{FI i;Require(GetFileInformationByHandle(f.SafeFileHandle.DangerousGetHandle(),out i)&&i.Links==1&&(i.Attributes&0x410)==0&&f.Length>0&&f.Length<=max,"FILE_IDENTITY_REJECTED");return f;}catch{f.Dispose();throw;}
  }
  static void RequireAbsentPath(string p,string code) {
    PathCheck(p);
    try {File.GetAttributes(p);}
    catch(FileNotFoundException){return;}
    // Directory, access error, orphan tomb or existing receipt is never absence.
    throw new InvalidOperationException(code);
  }
  static byte[] Read(FileStream f) {f.Position=0;byte[] b=new byte[(int)f.Length];int at=0;while(at<b.Length){int n=f.Read(b,at,b.Length-at);Require(n>0,"FILE_TRUNCATED");at+=n;}return b;}
  static string Fingerprint(string root) {
    IntPtr h=CreateFileW(root,0x80,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Require(h!=new IntPtr(-1)&&h!=IntPtr.Zero,"ROOT_OPEN_FAILED");
    try{FI i;Require(GetFileInformationByHandle(h,out i),"ROOT_IDENTITY_FAILED");ulong index=((ulong)i.IndexHigh<<32)|i.IndexLow;return Hash(Utf8.GetBytes(root+"\n"+i.VolumeSerial+"\n"+index));}finally{CloseHandle(h);}
  }
  static void RootAcl(string root) {
    DirectorySecurity a=Directory.GetAccessControl(root,AccessControlSections.Owner|AccessControlSections.Access);
    Require(a.GetOwner(typeof(SecurityIdentifier)).Value==Sid&&a.AreAccessRulesProtected,"ROOT_ACL_REJECTED");
    bool owner=false;foreach(FileSystemAccessRule rule in a.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
      Require(rule.AccessControlType==AccessControlType.Allow&&(rule.IdentityReference.Value==Sid||rule.IdentityReference.Value=="S-1-5-18"),"ROOT_ACL_REJECTED");
      if(rule.IdentityReference.Value==Sid&&(rule.FileSystemRights&FileSystemRights.FullControl)==FileSystemRights.FullControl)owner=true;
    }Require(owner,"ROOT_ACL_REJECTED");
  }
  static void CreateFile(string p,byte[] b) {PathCheck(p);using(FileStream f=new FileStream(p,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.Write(b,0,b.Length);f.Flush(true);}}
  static string Target(Dictionary<string,object> d) {return "ProjectHub.WorkerSshPassword.v1/"+(string)d["registrationId"]+"/"+Hash(Utf8.GetBytes(Canon(d)));}
  static void Validate(Dictionary<string,object> d) {
    Fields(d,"version","registrationId","root","rootFingerprint","ownerSid","host","port","user","hostKey","hostFingerprint","ssh","sshSHA256","brokerSHA256","stageCommand","stageCommandSHA256");
    Require(Num(d,"version",1,1)==1,"VERSION_REJECTED");
    Require(Regex.IsMatch(Str(d,"registrationId",36),@"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"),"ID_REJECTED");
    PathCheck(Str(d,"root",239));PathCheck(Str(d,"ssh",239));Require(Str(d,"ownerSid",184)==Sid,"OWNER_CHANGED");
    foreach(string k in new string[]{"rootFingerprint","sshSHA256","brokerSHA256","stageCommandSHA256"})Require(Regex.IsMatch(Str(d,k,64),"^[a-f0-9]{64}$"),"DIGEST_REJECTED");
    string host=Str(d,"host",15);System.Net.IPAddress ip;Require(System.Net.IPAddress.TryParse(host,out ip)&&ip.AddressFamily==System.Net.Sockets.AddressFamily.InterNetwork&&ip.ToString()==host,"HOST_REJECTED");
    Num(d,"port",1,65535);Require(Regex.IsMatch(Str(d,"user",32),"^[a-z_][a-z0-9_-]{0,31}$"),"USER_REJECTED");
    byte[] key=Convert.FromBase64String(Str(d,"hostKey",128));Require(key.Length==51&&Convert.ToBase64String(key)==(string)d["hostKey"]&&BitConverter.ToString(key,0,19)=="00-00-00-0B-73-73-68-2D-65-64-32-35-35-31-39-00-00-00-20","HOST_KEY_REJECTED");
    using(SHA256 s=SHA256.Create())Require(Str(d,"hostFingerprint",51)=="SHA256:"+Convert.ToBase64String(s.ComputeHash(key)).TrimEnd('='),"HOST_PIN_CHANGED");
    string command=Str(d,"stageCommand",1024);Require(Utf8.GetByteCount(command)<=1024&&command.IndexOf('\r')<0&&command.IndexOf('\n')<0&&Hash(Utf8.GetBytes(command))==(string)d["stageCommandSHA256"],"STAGE_COMMAND_REJECTED");
  }
  static string KnownHosts(Dictionary<string,object> d) {
    string host=(string)d["host"];int port=(int)d["port"];return (port==22?host:"["+host+"]:"+port)+" ssh-ed25519 "+(string)d["hostKey"]+"\n";
  }
  static string[] Args(Dictionary<string,object> d,string command) {
    var args=new List<string>{"-v","-F","/dev/null","-T","-p",d["port"].ToString()};
    foreach(string option in new string[]{"PubkeyAuthentication=no","KbdInteractiveAuthentication=no","PasswordAuthentication=yes","IdentityAgent=none","IdentityFile=none","UserKnownHostsFile="+Path.Combine((string)d["root"],"known_hosts").Replace('\\','/'),"GlobalKnownHostsFile=/dev/null","StrictHostKeyChecking=yes","HostKeyAlgorithms=ssh-ed25519","UpdateHostKeys=no","ForwardAgent=no","ForwardX11=no","ClearAllForwardings=yes","PermitLocalCommand=no","ConnectionAttempts=1","ConnectTimeout=8","ServerAliveInterval=10","ServerAliveCountMax=2","NumberOfPasswordPrompts=1","IdentitiesOnly=yes","PreferredAuthentications=password","ControlMaster=no","ControlPath=none"}){args.Add("-o");args.Add(option);}
    args.Add((string)d["user"]+"@"+(string)d["host"]);args.Add(command);return args.ToArray();
  }
  static void Event(string e) {Require(Regex.IsMatch(e,"^[A-Z0-9_:.-]{1,160}$"),"EVENT_REJECTED");Console.Error.WriteLine("HUB_VAULT_EVENT:"+e);Console.Error.Flush();}
  static HubSshVaultTransport.Result Connect(Dictionary<string,object> d,byte[] secret,bool probe,string nonce) {
    string command=probe?"python3 -I -c 'import os;print(\"HUB_SSH_IDENTITY_V1:"+nonce+":\"+str(os.getuid()))'":(string)d["stageCommand"];
    return HubSshVaultTransport.Run(new HubSshVaultTransport.Options {Ssh=(string)d["ssh"],Args=Args(d,command),Cwd=(string)d["root"],Helper=Self,Secret=secret,CaptureOutput=probe,DeadlineMs=probe?30000:720000,EventSink=Event,HostFingerprint=(string)d["hostFingerprint"]});
  }
  static int Probe(Dictionary<string,object> d,byte[] secret) {
    string nonce=Guid.NewGuid().ToString("N");var r=Connect(d,secret,true,nonce);
    Require(r.CleanupVerified,"SSH_CLEANUP_UNVERIFIED");Require(r.ExitCode==0&&r.Authenticated&&r.AskpassSupplied,"SSH_AUTHENTICATION_UNVERIFIED");
    string text=Utf8.GetString(r.Output);Match m=Regex.Match(text,"\\AHUB_SSH_IDENTITY_V1:"+nonce+":([1-9][0-9]{0,8})\\r?\\n\\z");int uid;
    Require(m.Success&&Int32.TryParse(m.Groups[1].Value,out uid)&&uid>0,"REMOTE_IDENTITY_REJECTED");Event("IDENTITY_VERIFIED");return Int32.Parse(m.Groups[1].Value);
  }
  static Dictionary<string,object> ReadReceipt(string file,string binding) {
    byte[] b;using(var f=HoldFile(file,65536))b=Read(f);
    byte[] plain=ProtectedData.Unprotect(b,Entropy,DataProtectionScope.CurrentUser);
    try{var r=Parse(Utf8.GetString(plain));Fields(r,"binding","state","target","uid");Require(Str(r,"binding",64)==binding&&Str(r,"state",16)=="active","REGISTRATION_INACTIVE_OR_CHANGED");Num(r,"uid",1,Int32.MaxValue);return r;}finally{Array.Clear(plain,0,plain.Length);}
  }
  static Dictionary<string,object> Result(string state) {return new Dictionary<string,object>{{"ok",true},{"state",state}};}
  static Dictionary<string,object> Handle(Dictionary<string,object> req) {
    string mode=Str(req,"mode",30);
    if(mode=="prepare") {
      Fields(req,"mode","parentRoot","parentFingerprint","leaf");string parent=PathCheck(Str(req,"parentRoot",200)),leaf=Str(req,"leaf",50);
      Require(Regex.IsMatch(leaf,"^[a-zA-Z0-9-]{1,50}$"),"ROOT_NAME_REJECTED");string preparedRoot=Path.Combine(parent,leaf);
      using(var pin=new HubPinnedRoot(parent,Str(req,"parentFingerprint",64))) {
        Require(!Directory.Exists(preparedRoot)&&!File.Exists(preparedRoot),"ROOT_ALREADY_EXISTS");
        DirectorySecurity a=new DirectorySecurity();a.SetOwner(new SecurityIdentifier(Sid));a.SetAccessRuleProtection(true,false);
        a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(Sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        byte[] security=a.GetSecurityDescriptorBinaryForm();IntPtr securityPointer=Marshal.AllocHGlobal(security.Length);
        try{Marshal.Copy(security,0,securityPointer,security.Length);SA sa=new SA();sa.Size=Marshal.SizeOf(typeof(SA));sa.Descriptor=securityPointer;Require(CreateDirectoryW(preparedRoot,ref sa),"PRIVATE_ROOT_CREATE_FAILED");}finally{Marshal.FreeHGlobal(securityPointer);}
        Event("PREPARE_CREATED");RootAcl(preparedRoot);Event("PREPARE_ACL_VERIFIED");pin.Verify();var r=Result("prepared");r["root"]=preparedRoot;r["rootFingerprint"]=Fingerprint(preparedRoot);r["ownerSid"]=Sid;return r;
      }
    }
    Fields(req,"mode","descriptor");var d=req["descriptor"] as Dictionary<string,object>;Validate(d);
    Require(mode=="enroll"||mode=="probe"||mode=="stage"||mode=="forget"||mode=="status"
#if HUB_SSH_VAULT_TEST
      ||mode=="enroll-fixture"
#endif
      ,"MODE_REJECTED");
    string root=(string)d["root"],target=Target(d),binding=Hash(Utf8.GetBytes(Canon(d))),receipt=Path.Combine(root,"registration.bin");
    using(var pin=new HubPinnedRoot(root,(string)d["rootFingerprint"])) {
      RootAcl(root);string lockPath=Path.Combine(root,"registration.lock");PathCheck(lockPath);
      using(var gate=new FileStream(lockPath,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
        FI li;Require(GetFileInformationByHandle(gate.SafeFileHandle.DangerousGetHandle(),out li)&&li.Links==1,"LOCK_IDENTITY_REJECTED");
        using(var exe=HoldFile(Self,16*1024*1024))using(var ssh=HoldFile((string)d["ssh"],32*1024*1024)) {
          Require(Hash(Read(exe))==(string)d["brokerSHA256"]&&Hash(Read(ssh))==(string)d["sshSHA256"],"CODE_IDENTITY_CHANGED");
          bool enroll=mode=="enroll"||mode=="enroll-fixture";
          if(enroll){RequireAbsentPath(receipt,"REGISTRATION_ALREADY_EXISTS");RequireAbsentPath(Path.Combine(root,"forgotten.bin"),"REGISTRATION_FORGOTTEN");Require(!HubSshVaultStore.Exists(target),"REGISTRATION_ALREADY_EXISTS");string kh=Path.Combine(root,"known_hosts");if(!File.Exists(kh))CreateFile(kh,Encoding.ASCII.GetBytes(KnownHosts(d)));}
          using(var kh=HoldFile(Path.Combine(root,"known_hosts"),1024)) {
          Require(Utf8.GetString(Read(kh))==KnownHosts(d),"HOST_PIN_FILE_CHANGED");
          if(enroll) {
            byte[] candidate=null;bool stored=false;
            try {
#if HUB_SSH_VAULT_TEST
              if(mode=="enroll-fixture"){Require((string)d["host"]=="127.0.0.1"&&(string)d["user"]=="fixture","FIXTURE_TARGET_REJECTED");candidate=Utf8.GetBytes(" Hub fixture 密碼 🔐 42 ");}
              else
#endif
              candidate=HubSshVaultEnrollment.Collect((string)d["user"],target,(string)d["host"]+":"+d["port"],Event);
              Event("SUBMITTED");int uid=Probe(d,candidate);pin.Verify();RootAcl(root);
              HubSshVaultStore.Create(target,(string)d["user"],candidate);stored=true;
              var record=new Dictionary<string,object>{{"binding",binding},{"target",target},{"state","active"},{"uid",uid}};
              CreateFile(receipt,ProtectedData.Protect(Utf8.GetBytes(Canon(record)),Entropy,DataProtectionScope.CurrentUser));
              ReadReceipt(receipt,binding);Event("STORED");var result=Result("stored");result["uid"]=uid;return result;
            }catch{if(stored){try{HubSshVaultStore.Delete(target);}catch{throw new InvalidOperationException("REGISTRATION_ROLLBACK_UNVERIFIED");}}throw;}
            finally{if(candidate!=null)Array.Clear(candidate,0,candidate.Length);}
          }
          var active=ReadReceipt(receipt,binding);Require((string)active["target"]==target,"TARGET_CHANGED");
          Require(!File.Exists(Path.Combine(root,"forgotten.bin")),"REGISTRATION_FORGOTTEN");
          if(mode=="forget") {
            // The exclusive registration lock excludes all other Hub runs.
            HubSshVaultStore.Delete(target);
            string tomb=Path.Combine(root,"forgotten.bin");
            CreateFile(tomb,ProtectedData.Protect(Utf8.GetBytes(Canon(new Dictionary<string,object>{{"binding",binding},{"state","forgotten"},{"target",target}})),Entropy,DataProtectionScope.CurrentUser));
            Require(!HubSshVaultStore.Exists(target)&&File.Exists(tomb),"FORGET_UNVERIFIED");return Result("forgotten");
          }
          if(mode=="status"){Require(HubSshVaultStore.Exists(target),"CREDENTIAL_MISSING");return Result("stored");}
          byte[] secret=HubSshVaultStore.Read(target,(string)d["user"]);
          try {
            if(mode=="probe"){int uid=Probe(d,secret);Require(uid==(int)active["uid"],"REMOTE_UID_CHANGED");var r=Result("connected");r["uid"]=uid;return r;}
            Require(Probe(d,secret)==(int)active["uid"],"REMOTE_UID_CHANGED");
            var stage=Connect(d,secret,false,"");Require(stage.CleanupVerified,"SSH_CLEANUP_UNVERIFIED");Require(stage.ExitCode==0&&stage.Authenticated&&stage.AskpassSupplied,"SSH_STAGE_FAILED");Event("STAGE_SSH_EXIT_0");return Result("stage-exited");
          }finally{Array.Clear(secret,0,secret.Length);}
          }
        }
      }
    }
  }
  [STAThread]
  static int Main() {
    if(Environment.GetEnvironmentVariable("HUB_SSH_VAULT_PIPE")!=null)return HubSshVaultTransport.Askpass();
    bool stage=false;
    try {
      string encoded=Environment.GetEnvironmentVariable("HUB_SSH_VAULT_REQUEST");Environment.SetEnvironmentVariable("HUB_SSH_VAULT_REQUEST",null);
      Require(encoded!=null&&encoded.Length<=32000,"REQUEST_MISSING");var req=Parse(Utf8.GetString(Convert.FromBase64String(encoded)));stage=(string)req["mode"]=="stage";
      var result=Handle(req);if(!stage)Console.WriteLine(Canon(result));return 0;
    }catch(Exception e) {
      string code=e is InvalidOperationException&&Regex.IsMatch(e.Message,"^[A-Z0-9_]{1,80}$")?e.Message:"VAULT_"+e.GetType().Name.ToUpperInvariant()+"_"+e.HResult.ToString("X8");
      Console.Error.WriteLine("HUB_VAULT_ERROR:"+code);if(!stage)Console.WriteLine("{\"code\":\""+code+"\",\"ok\":false}");return 125;
    }
  }
}
