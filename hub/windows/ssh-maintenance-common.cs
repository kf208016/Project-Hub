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

public static class HubSshMaintenanceCommon {
  public static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false,true);
  public static readonly string Sid = WindowsIdentity.GetCurrent().User.Value;
  public static readonly byte[] Entropy = Encoding.ASCII.GetBytes("ProjectHub.WorkerSshPassword.Receipt.v1");
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct FI {public uint Attributes;public FT Creation,Access,Write;public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [StructLayout(LayoutKind.Sequential)] struct SA {public int Size;public IntPtr Descriptor;public int Inherit;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SA sa);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FI info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr s,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static void Require(bool yes,string code) {if(!yes)throw new InvalidOperationException(code);}
  public static string Hash(byte[] b) {using(SHA256 s=SHA256.Create())return BitConverter.ToString(s.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
  public static string Self {get{return System.Reflection.Assembly.GetExecutingAssembly().Location;}}
  public static void Fields(Dictionary<string,object> d,params string[] names) {Require(d!=null&&d.Count==names.Length,"FIELDS_REJECTED");foreach(string n in names)Require(d.ContainsKey(n),"FIELDS_REJECTED");}
  public static string Str(Dictionary<string,object> d,string k,int max) {object v;Require(d.TryGetValue(k,out v)&&v is string,"FIELD_TYPE_REJECTED");string s=(string)v;Require(s.Length>0&&s.Length<=max,"FIELD_BOUND_REJECTED");foreach(char c in s)Require(c>=32&&c!=127,"CONTROL_CHARACTER_REJECTED");Utf8.GetBytes(s);return s;}
  public static int Num(Dictionary<string,object> d,string k,int min,int max) {object v;Require(d.TryGetValue(k,out v)&&v is int&&(int)v>=min&&(int)v<=max,"INTEGER_REJECTED");return (int)v;}
  public static string QuoteJson(string text) {
    Utf8.GetByteCount(text);StringBuilder b=new StringBuilder("\"");
    foreach(char c in text){switch(c){case '"':b.Append("\\\"");break;case '\\':b.Append("\\\\");break;case '\b':b.Append("\\b");break;case '\f':b.Append("\\f");break;case '\n':b.Append("\\n");break;case '\r':b.Append("\\r");break;case '\t':b.Append("\\t");break;default:if(c<32)b.Append("\\u"+((int)c).ToString("x4"));else b.Append(c);break;}}
    return b.Append('"').ToString();
  }
  public static string Canon(object value) {
    Dictionary<string,object> d=value as Dictionary<string,object>;
    if(d!=null){var keys=new List<string>(d.Keys);keys.Sort(StringComparer.Ordinal);var parts=new List<string>();foreach(string k in keys)parts.Add(QuoteJson(k)+":"+Canon(d[k]));return "{"+String.Join(",",parts.ToArray())+"}";}
    if(value is string)return QuoteJson((string)value);
    if(value is bool||value is int||value==null)return Json.Serialize(value);
    throw new InvalidOperationException("JSON_TYPE_REJECTED");
  }
  public static Dictionary<string,object> Parse(string s) {
    Require(s!=null&&s.Length<=64000,"REQUEST_BOUND_REJECTED");var d=Json.DeserializeObject(s) as Dictionary<string,object>;
    // Canonical bytes also reject duplicate keys, alternate escapes and ignored data.
    Require(d!=null&&Canon(d)==s,"NONCANONICAL_JSON_REJECTED");return d;
  }
  public static string PathCheck(string p) {
    Require(p!=null&&Regex.IsMatch(p,@"^[A-Za-z]:\\")&&p.Length<240&&!p.EndsWith("\\")&&Path.GetFullPath(p)==p,"PATH_REJECTED");
    string current=Path.GetPathRoot(p);
    foreach(string part in p.Substring(current.Length).Split('\\')) {
      Require(part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".")&&!part.EndsWith(" ")&&part.IndexOf(':')<0,"PATH_REJECTED");
      current=Path.Combine(current,part);
      if(File.Exists(current)||Directory.Exists(current))Require((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"REPARSE_REJECTED");
    }return p;
  }
  public static FileStream HoldFile(string p,int max) {
    PathCheck(p);FileStream f=new FileStream(p,FileMode.Open,FileAccess.Read,FileShare.Read);
    try{FI i;Require(GetFileInformationByHandle(f.SafeFileHandle.DangerousGetHandle(),out i)&&i.Links==1&&(i.Attributes&0x410)==0&&f.Length>0&&f.Length<=max,"FILE_IDENTITY_REJECTED");return f;}catch{f.Dispose();throw;}
  }
  public static void RequireAbsentPath(string p,string code) {
    PathCheck(p);
    try {File.GetAttributes(p);}
    catch(FileNotFoundException){return;}
    // Directory, access error, orphan tomb or existing receipt is never absence.
    throw new InvalidOperationException(code);
  }
  public static byte[] Read(FileStream f) {f.Position=0;byte[] b=new byte[(int)f.Length];int at=0;while(at<b.Length){int n=f.Read(b,at,b.Length-at);Require(n>0,"FILE_TRUNCATED");at+=n;}return b;}
  public static string Fingerprint(string root) {
    IntPtr h=CreateFileW(root,0x80,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Require(h!=new IntPtr(-1)&&h!=IntPtr.Zero,"ROOT_OPEN_FAILED");
    try{FI i;Require(GetFileInformationByHandle(h,out i),"ROOT_IDENTITY_FAILED");ulong index=((ulong)i.IndexHigh<<32)|i.IndexLow;return Hash(Utf8.GetBytes(root+"\n"+i.VolumeSerial+"\n"+index));}finally{CloseHandle(h);}
  }
  public static void RootAcl(string root) {
    DirectorySecurity a=Directory.GetAccessControl(root,AccessControlSections.Owner|AccessControlSections.Access);
    Require(a.GetOwner(typeof(SecurityIdentifier)).Value==Sid&&a.AreAccessRulesProtected,"ROOT_ACL_REJECTED");
    bool owner=false;foreach(FileSystemAccessRule rule in a.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
      Require(rule.AccessControlType==AccessControlType.Allow&&(rule.IdentityReference.Value==Sid||rule.IdentityReference.Value=="S-1-5-18"),"ROOT_ACL_REJECTED");
      if(rule.IdentityReference.Value==Sid&&(rule.FileSystemRights&FileSystemRights.FullControl)==FileSystemRights.FullControl)owner=true;
    }Require(owner,"ROOT_ACL_REJECTED");
  }
  public static void CreateFile(string p,byte[] b) {PathCheck(p);using(FileStream f=new FileStream(p,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.Write(b,0,b.Length);f.Flush(true);}}
  public static string Target(Dictionary<string,object> d) {return "ProjectHub.WorkerSshPassword.v1/"+(string)d["registrationId"]+"/"+Hash(Utf8.GetBytes(Canon(d)));}
  public static void Validate(Dictionary<string,object> d) {
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
  public static string KnownHosts(Dictionary<string,object> d) {
    string host=(string)d["host"];int port=(int)d["port"];return (port==22?host:"["+host+"]:"+port)+" ssh-ed25519 "+(string)d["hostKey"]+"\n";
  }
  public static string[] Args(Dictionary<string,object> d,string command) {
    var args=new List<string>{"-v","-F","/dev/null","-T","-p",d["port"].ToString()};
    foreach(string option in new string[]{"PubkeyAuthentication=no","KbdInteractiveAuthentication=no","PasswordAuthentication=yes","IdentityAgent=none","IdentityFile=none","UserKnownHostsFile="+Path.Combine((string)d["root"],"known_hosts").Replace('\\','/'),"GlobalKnownHostsFile=/dev/null","StrictHostKeyChecking=yes","HostKeyAlgorithms=ssh-ed25519","UpdateHostKeys=no","ForwardAgent=no","ForwardX11=no","ClearAllForwardings=yes","PermitLocalCommand=no","ConnectionAttempts=1","ConnectTimeout=8","ServerAliveInterval=10","ServerAliveCountMax=2","NumberOfPasswordPrompts=1","IdentitiesOnly=yes","PreferredAuthentications=password","ControlMaster=no","ControlPath=none"}){args.Add("-o");args.Add(option);}
    args.Add((string)d["user"]+"@"+(string)d["host"]);args.Add(command);return args.ToArray();
  }
  public static Dictionary<string,object> Result(string state) {return new Dictionary<string,object>{{"ok",true},{"state",state}};}
  public static byte[] Protected(string text) {return ProtectedData.Protect(Utf8.GetBytes(text),Entropy,DataProtectionScope.CurrentUser);}
  public static Dictionary<string,object> UnprotectFile(string path) {byte[] blob;using(var f=HoldFile(path,65536))blob=Read(f);byte[] plain=ProtectedData.Unprotect(blob,Entropy,DataProtectionScope.CurrentUser);try{return Parse(Utf8.GetString(plain));}finally{Array.Clear(plain,0,plain.Length);}}
  public static string Binding(Dictionary<string,object> d) {return Hash(Utf8.GetBytes(Canon(d)));}
  public static Dictionary<string,object> OldReceipt(Dictionary<string,object> d,string expectedHash) {string p=Path.Combine((string)d["root"],"registration.bin");Dictionary<string,object> r;using(var f=HoldFile(p,65536)){byte[] blob=Read(f);Require(Hash(blob)==expectedHash,"SOURCE_RECEIPT_CHANGED");byte[] plain=ProtectedData.Unprotect(blob,Entropy,DataProtectionScope.CurrentUser);try{r=Parse(Utf8.GetString(plain));}finally{Array.Clear(plain,0,plain.Length);}}Fields(r,"binding","state","target","uid");Require(Str(r,"binding",64)==Binding(d)&&Str(r,"state",16)=="active"&&Str(r,"target",180)==Target(d),"SOURCE_RECEIPT_CHANGED");Num(r,"uid",1,Int32.MaxValue);return r;}
  public static FileStream Gate(string root,string leaf) {PathCheck(root);string p=Path.Combine(root,leaf);PathCheck(p);var f=new FileStream(p,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);try{FI i;Require(GetFileInformationByHandle(f.SafeFileHandle.DangerousGetHandle(),out i)&&i.Links==1&&(i.Attributes&0x410)==0,"LOCK_IDENTITY_REJECTED");return f;}catch{f.Dispose();throw;}}
  public static bool Exists(string path) {PathCheck(path);try{File.GetAttributes(path);return true;}catch(FileNotFoundException){return false;}}
  public static void Event(string name) {Require(Regex.IsMatch(name,"^[A-Z0-9_:.-]{1,160}$"),"EVENT_REJECTED");Console.Error.WriteLine("HUB_MAINTENANCE_EVENT:"+name);Console.Error.Flush();}
  public static string Error(Exception e) {return e is InvalidOperationException&&Regex.IsMatch(e.Message,"^[A-Z0-9_]{1,100}$")?e.Message:"MAINTENANCE_"+e.GetType().Name.ToUpperInvariant()+"_"+e.HResult.ToString("X8");}
}
