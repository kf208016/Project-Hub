// W0 controller with an initial bootstrap gate and the fixed synthetic cases.
// Not a provider adapter/service. Compile with claude-lpac-cases.cs/pinned-root.cs.
// No-argument/--describe execution is inert. The approved execution switch is
// deliberately separate; building this file never creates an AppContainer.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

partial class HubClaudeLpacProbe {
  const uint QueryToken=8, DuplicateToken=2, ImpersonateToken=4;
  const uint JobFlags=0x2000|0x200|0x8|0x4; // kill-on-close, job memory, active processes, job CPU
  const int MaxOutput=65536;
  const int LpacPrivilegeCapacity=4096;
  const string LpacAccessSddl="O:SYG:SYD:(A;;0x3;;;WD)(A;;0x1;;;S-1-15-2-1)(A;;0x2;;;S-1-15-2-2)";
  const string LpacAccessMethod="chromium-access-check-v1";
  const string LpacAccessRevision="5c210565c3fa181730df37778d22af487a0d5e40";
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static readonly Regex NoncePattern=new Regex("\\A[a-f0-9]{32}\\z",RegexOptions.CultureInvariant);
  static readonly Regex HashPattern=new Regex("\\A[a-f0-9]{64}\\z",RegexOptions.CultureInvariant);
  [StructLayout(LayoutKind.Sequential)] struct SA {public int Size;public IntPtr Descriptor;public int Inherit;}
  [StructLayout(LayoutKind.Sequential)] struct SI {public int Size;public IntPtr Reserved,Desktop,Title;public int X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public short Show,ReservedSize;public IntPtr ReservedBytes,Input,Output,Error;}
  [StructLayout(LayoutKind.Sequential)] struct SIX {public SI Info;public IntPtr Attributes;}
  [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr Process,Thread;public uint Pid,Tid;}
  [StructLayout(LayoutKind.Sequential)] struct SC {public IntPtr Sid,Capabilities;public uint Count,Reserved;}
  [StructLayout(LayoutKind.Sequential)] struct BL {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct IO {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct XL {public BL Basic;public IO Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
  [StructLayout(LayoutKind.Sequential)] struct FI {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [StructLayout(LayoutKind.Sequential)] struct US {public ushort Length,Maximum;public IntPtr Buffer;}
  [StructLayout(LayoutKind.Sequential)] struct OA {public uint Length;public IntPtr Root,Name;public uint Attributes;public IntPtr Descriptor,Qos;}
  [StructLayout(LayoutKind.Sequential)] struct DISPOSITION {public byte Delete;}
  [StructLayout(LayoutKind.Sequential)] struct GenericMapping {public uint Read,Write,Execute,All;}
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
  [DllImport("userenv.dll")] static extern int GetAppContainerRegistryLocation(uint access,out IntPtr key);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int capacity,out int returned);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attrs,int level,int type,out IntPtr duplicate);
  [DllImport("advapi32.dll")] static extern bool IsValidSecurityDescriptor(IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(IntPtr descriptor,IntPtr token,uint desired,ref GenericMapping mapping,IntPtr privileges,ref uint privilegeBytes,out uint granted,out bool accessStatus);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool RevertToSelf();
  [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileSecurity(string path,uint information,IntPtr descriptor);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string name,int kind,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor,uint revision,uint information,out IntPtr text,out uint length);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("ntdll.dll")] static extern int NtQueryKey(IntPtr key,int kind,IntPtr data,uint capacity,out uint returned);
  [DllImport("ntdll.dll")] static extern int NtOpenKey(out IntPtr key,uint access,ref OA attributes);
  [DllImport("ntdll.dll")] static extern int NtClose(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref SA attributes);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr attrs,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributes(string path);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FI info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder name,uint capacity,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr file,int kind,ref DISPOSITION info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attrs,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,IntPtr name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref XL info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool found);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string file,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  sealed class Rejected:Exception {public readonly string Code;public readonly int Native;public Rejected(string code,int native):base(code){Code=code;Native=native;}}
  sealed class HeldFile:IDisposable {public readonly FileStream Stream;public readonly string Identity;public HeldFile(string path){IntPtr h=CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Need(h!=new IntPtr(-1),"FILE_OPEN_FAILED",Marshal.GetLastWin32Error());try{FI f;Win(GetFileInformationByHandle(h,out f),"FILE_IDENTITY_FAILED");Need((f.Attributes&0x410)==0&&f.Links==1,"FILE_TYPE_REJECTED");Need(Final(h)==path,"FILE_PATH_CHANGED");Identity=IdentityOf(f);Stream=new FileStream(new SafeFileHandle(h,true),FileAccess.Read);h=IntPtr.Zero;}finally{if(h!=IntPtr.Zero)CloseHandle(h);}}public void Dispose(){if(Stream!=null)Stream.Dispose();}}
  readonly SortedDictionary<string,object> result=new SortedDictionary<string,object>(StringComparer.Ordinal);
  readonly List<object> events=new List<object>();
  readonly List<HubPinnedRoot> pins=new List<HubPinnedRoot>();
  HubPinnedRoot profilePin;
  readonly Stopwatch total=Stopwatch.StartNew();
  string stage="prepared",failureStage,owner,nonce,parent,root,journalPath,profileName,profileSid,profileFolder,registryPath,profileIdentity,rootIdentity,fixtureHash,fixtureFile;
  IntPtr expectedSid=IntPtr.Zero;
  FileStream journal;
  bool creationAttempted,creationOutcomeKnown,created,createdReceipt,registryCaptured,ownerContext=true,jobEmpty=true,bootstrapPassed,cleanupVerified;
  int sequence;
  static void Need(bool value,string code){Need(value,code,0);}
  static void Need(bool value,string code,int native){if(!value)throw new Rejected(code,native);}
  static void Win(bool value,string code){if(!value)throw new Rejected(code,Marshal.GetLastWin32Error());}
  static string Digest(Stream stream){using(SHA256 hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
  static string IdentityOf(FI f){return f.Volume.ToString("x8")+":"+f.IndexHigh.ToString("x8")+f.IndexLow.ToString("x8");}
  static string Absolute(string path){Need(path!=null&&path.Length>3&&path.Length<30000&&Regex.IsMatch(path,"\\A[A-Za-z]:\\\\")&&path.IndexOf('\0')<0,"PATH_REJECTED");string full=Path.GetFullPath(path).TrimEnd('\\');Need(full==path.TrimEnd('\\')&&full.IndexOf(':',2)<0&&full.IndexOf('/')<0,"PATH_REJECTED");foreach(string part in full.Substring(3).Split('\\'))Need(part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".")&&!part.EndsWith(" "),"PATH_REJECTED");return full;}
  static string Final(IntPtr handle){StringBuilder b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(handle,b,(uint)b.Capacity,0);Win(n>0&&n<b.Capacity,"FILE_PATH_FAILED");string p=b.ToString();Need(p.StartsWith("\\\\?\\",StringComparison.Ordinal),"FILE_PATH_REJECTED");return p.Substring(4);}
  static FI DirectoryInfo(string path){IntPtr h=CreateFile(path,0x20080,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Need(h!=new IntPtr(-1),"DIRECTORY_OPEN_FAILED",Marshal.GetLastWin32Error());try{FI f;Win(GetFileInformationByHandle(h,out f),"DIRECTORY_IDENTITY_FAILED");Need((f.Attributes&0x410)==0x10&&Final(h)==path,"DIRECTORY_TYPE_REJECTED");return f;}finally{CloseHandle(h);}}
  static string Fingerprint(string path,FI f){byte[] b=Utf8.GetBytes(path+"\n"+f.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture)+"\n"+(((ulong)f.IndexHigh<<32)|f.IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture));using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
  static string OwnerOf(string path,bool directory){return (directory?(FileSystemSecurity)Directory.GetAccessControl(path,AccessControlSections.Owner):File.GetAccessControl(path,AccessControlSections.Owner)).GetOwner(typeof(SecurityIdentifier)).Value;}
  void PinDirectory(string path){FI f=DirectoryInfo(path);Need(OwnerOf(path,true)==owner,"DIRECTORY_OWNER_CHANGED");pins.Add(new HubPinnedRoot(path,Fingerprint(path,f)));}
  static bool Absent(string path){uint attrs=GetFileAttributes(path);if(attrs!=0xffffffff)return false;int e=Marshal.GetLastWin32Error();Need(e==2||e==3,"PATH_ABSENCE_UNKNOWN",e);return true;}
  void MakeDirectory(string path){IntPtr sd=IntPtr.Zero;uint n;Win(ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+owner+"D:P(A;OICI;FA;;;"+owner+")",1,out sd,out n),"ACL_BUILD_FAILED");try{SA a=new SA();a.Size=Marshal.SizeOf(typeof(SA));a.Descriptor=sd;Win(CreateDirectory(path,ref a),"DIRECTORY_CREATE_FAILED");Need(OwnerOf(path,true)==owner,"DIRECTORY_OWNER_CHANGED");}finally{LocalFree(sd);}}
  static bool PrivateAclMatches(RawSecurityDescriptor expected,RawSecurityDescriptor observed){
    if(expected==null||observed==null||expected.Owner==null||!expected.Owner.Equals(observed.Owner)||expected.DiscretionaryAcl==null||observed.DiscretionaryAcl==null)return false;
    ControlFlags required=ControlFlags.DiscretionaryAclPresent|ControlFlags.DiscretionaryAclProtected;
    if((expected.ControlFlags&required)!=required||(observed.ControlFlags&required)!=required)return false;
    // Windows may add AI while applying a protected DACL. It is bookkeeping;
    // every other control bit and the complete ordered ACL bytes must agree.
    ControlFlags compared=~ControlFlags.DiscretionaryAclAutoInherited;
    if((expected.ControlFlags&compared)!=(observed.ControlFlags&compared))return false;
    RawAcl wanted=expected.DiscretionaryAcl,actual=observed.DiscretionaryAcl;
    if(wanted.BinaryLength!=actual.BinaryLength)return false;
    byte[] a=new byte[wanted.BinaryLength],b=new byte[actual.BinaryLength];wanted.GetBinaryForm(a,0);actual.GetBinaryForm(b,0);
    for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;
    return true;
  }
  void SetAcl(string path,string access,bool directory,bool low){string sddl="O:"+owner+"D:P(A;OICI;FA;;;"+owner+")"+(access==null?"":"(A;"+(directory?"OICI":"")+";"+access+";;;"+profileSid+")");FileSystemSecurity security=directory?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();security.SetSecurityDescriptorSddlForm(sddl,AccessControlSections.Owner|AccessControlSections.Access);if(directory)Directory.SetAccessControl(path,(DirectorySecurity)security);else File.SetAccessControl(path,(FileSecurity)security);FileSystemSecurity observed=directory?(FileSystemSecurity)Directory.GetAccessControl(path,AccessControlSections.Owner|AccessControlSections.Access):File.GetAccessControl(path,AccessControlSections.Owner|AccessControlSections.Access);Need(PrivateAclMatches(new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(),0),new RawSecurityDescriptor(observed.GetSecurityDescriptorBinaryForm(),0)),"ACL_VERIFY_FAILED");if(low){IntPtr sd=IntPtr.Zero;uint size;Win(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out sd,out size),"LABEL_BUILD_FAILED");try{Win(SetFileSecurity(path,0x10,sd),"LABEL_SET_FAILED");VerifyLowLabel(path);}finally{LocalFree(sd);}}}
  void Record(string kind,params object[] fields){Need(ownerContext,"OWNER_CONTEXT_UNKNOWN");SortedDictionary<string,object> row=new SortedDictionary<string,object>(StringComparer.Ordinal);row["sequence"]=++sequence;row["kind"]=kind;row["stage"]=stage;row["runNonce"]=nonce;for(int i=0;i<fields.Length;i+=2)row[(string)fields[i]]=fields[i+1];byte[] bytes=Utf8.GetBytes(new JavaScriptSerializer().Serialize(row)+"\n");if(journal!=null){journal.Write(bytes,0,bytes.Length);journal.Flush(true);}events.Add(row);}
  static string TokenQueryCode(int kind,string reason){return "TOKEN_CLASS_"+kind.ToString(System.Globalization.CultureInfo.InvariantCulture)+"_"+reason;}
  static int TokenSizingCapacity(int kind,bool success,int error,int required){
    // Only ERROR_INSUFFICIENT_BUFFER establishes a valid sizing response.
    // An unsupported class can leave ReturnLength unwritten: preserve the
    // original error rather than misreporting it as a zero-sized structure.
    Need(!success,TokenQueryCode(kind,"SIZE_QUERY_INVALID"));
    Need(error==122,TokenQueryCode(kind,"QUERY_UNAVAILABLE"),error);
    Need(required>0&&required<=65536,TokenQueryCode(kind,"SIZE_INVALID"),error);
    return required;
  }
  static int TokenReturnedLength(int kind,bool success,int error,int capacity,int returned){
    Need(success,TokenQueryCode(kind,"QUERY_FAILED"),error);
    Need(capacity>0&&capacity<=65536&&returned>0&&returned<=capacity,TokenQueryCode(kind,"SIZE_INVALID"));
    return returned;
  }
  static IntPtr TokenData(IntPtr token,int kind,out int length){
    bool sized=GetTokenInformation(token,kind,IntPtr.Zero,0,out length);int error=Marshal.GetLastWin32Error();
    length=TokenSizingCapacity(kind,sized,sized?0:error,length);
    IntPtr p=Marshal.AllocHGlobal(length);
    try{
      int got;bool success=GetTokenInformation(token,kind,p,length,out got);error=Marshal.GetLastWin32Error();
      length=TokenReturnedLength(kind,success,success?0:error,length,got);return p;
    }catch{Marshal.FreeHGlobal(p);throw;}
  }
  static int TokenScalarLength(int kind,int length){Need(length==4,TokenQueryCode(kind,"SCALAR_SIZE_INVALID_"+length.ToString(System.Globalization.CultureInfo.InvariantCulture)));return length;}
  static int Scalar(IntPtr token,int kind){int n;IntPtr p=TokenData(token,kind,out n);try{TokenScalarLength(kind,n);return Marshal.ReadInt32(p);}finally{Marshal.FreeHGlobal(p);}}
  static bool RestrictionBooleanValue(int kind,int length,int value){
    Need(kind==21,"TOKEN_RESTRICTION_CLASS_INVALID");
    Need(length==1,TokenQueryCode(kind,"BOOLEAN_SIZE_INVALID_"+length.ToString(System.Globalization.CultureInfo.InvariantCulture)));
    Need(value==0||value==1,"TOKEN_CLASS_21_BOOLEAN_VALUE_INVALID");
    return value==1;
  }
  static SortedDictionary<string,object> QueryRestrictions(IntPtr token){
    // This exact class/one-byte representation is measured on this W0 host,
    // not a portable reinterpretation of the published DWORD description.
    int n;IntPtr p=TokenData(token,21,out n);
    try{
      Need(n==1,TokenQueryCode(21,"BOOLEAN_SIZE_INVALID_"+n.ToString(System.Globalization.CultureInfo.InvariantCulture)));
      bool value=RestrictionBooleanValue(21,n,Marshal.ReadByte(p));
      SortedDictionary<string,object> r=new SortedDictionary<string,object>(StringComparer.Ordinal);
      r["api"]="GetTokenInformation";r["informationClass"]=21;r["returnedBytes"]=1;
      r["encoding"]="BOOLEAN-1";r["validationScope"]="measured-host-abi-v1";r["value"]=value;
      return r;
    }finally{Marshal.FreeHGlobal(p);}
  }
  // Fixed semantic probe from Chromium CheckLpacToken. The descriptor is an
  // in-memory private object; no filesystem/registry ACL or thread token changes.
  static SortedDictionary<string,object> ValidateLpacAccess(bool success,int error,bool accessStatus,uint granted,uint expected,uint capacity,uint returned,uint privilegeCount){
    Need(expected==2||expected==3,"LPAC_ACCESS_EXPECTATION_INVALID");
    Need(success,"LPAC_ACCESS_QUERY_FAILED",error);
    Need(accessStatus,"LPAC_ACCESS_DENIED",error);
    Need(granted==expected,"LPAC_ACCESS_MASK_MISMATCH");
    Need(capacity==LpacPrivilegeCapacity&&returned>=8&&returned<=capacity,"LPAC_ACCESS_PRIVILEGE_SIZE_INVALID");
    // This fixed descriptor grants only private rights 0x1/0x2. No privilege
    // may contribute; a nonzero list is outside the validated semantic probe.
    Need(privilegeCount==0,"LPAC_ACCESS_PRIVILEGE_COUNT_INVALID");
    SortedDictionary<string,object> r=new SortedDictionary<string,object>(StringComparer.Ordinal);
    r["functionSucceeded"]=true;r["accessStatus"]=true;r["grantedMask"]=granted;r["nativeCode"]=0;
    r["privilegeSetCapacity"]=capacity;r["privilegeSetReturnedBytes"]=returned;r["privilegeCount"]=privilegeCount;
    return r;
  }
  static SortedDictionary<string,object> LpacAccess(IntPtr source,uint expected){
    IntPtr duplicate=IntPtr.Zero,descriptor=IntPtr.Zero,privileges=IntPtr.Zero;
    try{
      Need(expected==2||expected==3,"LPAC_ACCESS_EXPECTATION_INVALID");
      // SecurityIdentification, TokenImpersonation, TOKEN_QUERY only.
      Win(DuplicateTokenEx(source,QueryToken,IntPtr.Zero,1,2,out duplicate),"LPAC_ACCESS_DUPLICATE_FAILED");
      Need(duplicate!=IntPtr.Zero&&Scalar(duplicate,8)==2&&Scalar(duplicate,9)==1,"LPAC_ACCESS_DUPLICATE_TYPE_MISMATCH");
      Need(TokenSid(source,1)==TokenSid(duplicate,1)&&Scalar(source,29)==Scalar(duplicate,29),"LPAC_ACCESS_DUPLICATE_IDENTITY_MISMATCH");
      if(Scalar(source,29)==1)Need(TokenSid(source,31)==TokenSid(duplicate,31),"LPAC_ACCESS_DUPLICATE_PROFILE_MISMATCH");
      RawSecurityDescriptor sd=new RawSecurityDescriptor(LpacAccessSddl);byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);
      descriptor=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,descriptor,bytes.Length);
      Need(IsValidSecurityDescriptor(descriptor),"LPAC_ACCESS_DESCRIPTOR_INVALID");
      privileges=Marshal.AllocHGlobal(LpacPrivilegeCapacity);Marshal.Copy(new byte[LpacPrivilegeCapacity],0,privileges,LpacPrivilegeCapacity);
      GenericMapping mapping=new GenericMapping();uint returned=LpacPrivilegeCapacity,granted;bool accessStatus;
      SetLastError(0);
      bool success=AccessCheck(descriptor,duplicate,0x02000000,ref mapping,privileges,ref returned,out granted,out accessStatus);int error=Marshal.GetLastWin32Error();
      // API failure leaves output fields undefined. Do not inspect the buffer.
      Need(success,"LPAC_ACCESS_QUERY_FAILED",error);
      Need(returned>=8&&returned<=LpacPrivilegeCapacity,"LPAC_ACCESS_PRIVILEGE_SIZE_INVALID");
      uint count=unchecked((uint)Marshal.ReadInt32(privileges));
      return ValidateLpacAccess(true,accessStatus?0:error,accessStatus,granted,expected,LpacPrivilegeCapacity,returned,count);
    }finally{
      foreach(IntPtr p in new IntPtr[]{descriptor,privileges})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);
      if(duplicate!=IntPtr.Zero)Need(CloseHandle(duplicate),"LPAC_ACCESS_DUPLICATE_CLOSE_UNKNOWN");
    }
  }
  static SortedDictionary<string,object> LpacOwnerControl(string expectedOwner){
    IntPtr token;Win(OpenProcessToken(GetCurrentProcess(),QueryToken|DuplicateToken,out token),"LPAC_OWNER_TOKEN_OPEN_FAILED");
    try{Need(TokenSid(token,1)==expectedOwner&&Scalar(token,8)==1,"LPAC_OWNER_TOKEN_MISMATCH");return LpacAccess(token,3);}
    finally{Need(CloseHandle(token),"LPAC_OWNER_TOKEN_CLOSE_UNKNOWN");}
  }
  static SortedDictionary<string,object> Class46Observation(bool success,int error,int returned,uint value){
    SortedDictionary<string,object> r=new SortedDictionary<string,object>(StringComparer.Ordinal);
    r["api"]="GetTokenInformation";r["informationClass"]=46;r["capacity"]=4;
    if(!success){
      Need(error==87,"TOKEN_CLASS_46_QUERY_FAILED",error);
      r["queryUnavailable"]=true;r["nativeCode"]=87;r["returnedBytes"]=null;r["value"]=null;
    }else{
      Need(returned==4,"TOKEN_CLASS_46_SIZE_INVALID");
      Need(value==1,"TOKEN_CLASS_46_LPAC_MISMATCH");
      r["queryUnavailable"]=false;r["nativeCode"]=0;r["returnedBytes"]=4;r["value"]=1;
    }
    return r;
  }
  static SortedDictionary<string,object> SupplementalLpacQuery(IntPtr token){
    IntPtr buffer=Marshal.AllocHGlobal(4);
    try{
      Marshal.WriteInt32(buffer,0);int returned;SetLastError(0);
      bool success=GetTokenInformation(token,46,buffer,4,out returned);int error=Marshal.GetLastWin32Error();
      return Class46Observation(success,success?0:error,success?returned:0,success?unchecked((uint)Marshal.ReadInt32(buffer)):0);
    }finally{Marshal.FreeHGlobal(buffer);}
  }
  static string TokenSid(IntPtr token,int kind){int n;IntPtr p=TokenData(token,kind,out n);try{return SidFromBuffer(p,n);}finally{Marshal.FreeHGlobal(p);}}
  static void VerifyLowLabel(string path){
    IntPtr o,g,d,s,sd,text=IntPtr.Zero;uint status=GetNamedSecurityInfo(path,1,0x10,out o,out g,out d,out s,out sd);
    Need(status==0&&sd!=IntPtr.Zero,"LABEL_QUERY_FAILED",unchecked((int)status));
    try{uint n;Win(ConvertSecurityDescriptorToStringSecurityDescriptor(sd,1,0x10,out text,out n),"LABEL_QUERY_FAILED");string actual=Marshal.PtrToStringUni(text);Need(actual=="S:(ML;OICI;NW;;;LW)"||actual=="S:AI(ML;OICI;NW;;;LW)","LABEL_VERIFY_FAILED");}
    finally{if(text!=IntPtr.Zero)LocalFree(text);LocalFree(sd);}
  }
  void VerifyProfileToken(IntPtr process){
    IntPtr token;Win(OpenProcessToken(process,QueryToken,out token),"TOKEN_OPEN_FAILED");
    try{Need(TokenSid(token,1)==owner,"TOKEN_OWNER_MISMATCH");Need(Scalar(token,29)==1,"TOKEN_PROFILE_MISMATCH");int n;IntPtr p=TokenData(token,31,out n);try{Need(SidFromBuffer(p,n)==profileSid,"TOKEN_PROFILE_MISMATCH");}finally{Marshal.FreeHGlobal(p);}}
    finally{CloseHandle(token);}
  }
  long MeasureTree(string path,int depth,ref int entries){
    Need(depth<=16,"DISK_MEASUREMENT_DEPTH");FI before=DirectoryInfo(path);
    using(HubPinnedRoot held=new HubPinnedRoot(path,Fingerprint(path,before))){
      long bytes=0;string[] children=Directory.GetFileSystemEntries(path);
      foreach(string item in children){Need(++entries<=2048,"DISK_MEASUREMENT_ENTRIES");uint attr=GetFileAttributes(item);Need(attr!=0xffffffff&&(attr&0x400)==0,"DISK_MEASUREMENT_UNKNOWN");if((attr&0x10)!=0)bytes=checked(bytes+MeasureTree(item,depth+1,ref entries));else bytes=checked(bytes+MeasureFileSize(item));Need(bytes<=134217728,"DISK_SOFT_BUDGET_EXCEEDED");}held.Verify();return bytes;
    }
  }
  static long MeasureFileSize(string path){
    // Metadata measurement must not impose immutable-source sharing on a
    // legitimate fixture writer. This is an observation, never a disk quota.
    IntPtr h=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    Need(h!=new IntPtr(-1),"DISK_MEASUREMENT_UNKNOWN",Marshal.GetLastWin32Error());
    try{FI f;Win(GetFileInformationByHandle(h,out f),"DISK_MEASUREMENT_UNKNOWN");Need((f.Attributes&0x410)==0&&f.Links==1&&Final(h)==path,"DISK_MEASUREMENT_UNKNOWN");ulong size=((ulong)f.SizeHigh<<32)|f.SizeLow;Need(size<=Int64.MaxValue,"DISK_MEASUREMENT_UNKNOWN");return (long)size;}finally{CloseHandle(h);}
  }
  void CheckBudget(){
    Need(ownerContext,"OWNER_CONTEXT_UNKNOWN");int entries=0;long bytes=MeasureTree(root,0,ref entries);
    if(profileFolder!=null)bytes=checked(bytes+MeasureTree(profileFolder,0,ref entries));
    Need(bytes<=134217728,"DISK_SOFT_BUDGET_EXCEEDED");Need(new DriveInfo(Path.GetPathRoot(root)).AvailableFreeSpace>=67108864,"DISK_CLEANUP_RESERVE_SHORTFALL");
    if(profileFolder!=null)Need(new DriveInfo(Path.GetPathRoot(profileFolder)).AvailableFreeSpace>=67108864,"DISK_CLEANUP_RESERVE_SHORTFALL");
    result["measuredFolderBytes"]=bytes;
    result["diskMeasurementScope"]="owned-temp-and-profile-folder-files; registry-hive-allocation-not-attributed; soft-budget-only";
  }
  static string SidFromBuffer(IntPtr buffer,int length){Need(length>=IntPtr.Size,"TOKEN_SID_INVALID");IntPtr sid=Marshal.ReadIntPtr(buffer);long start=buffer.ToInt64(),point=sid.ToInt64();Need(point>=start&&point-start<=length-8,"TOKEN_SID_INVALID");Need(IsValidSid(sid),"TOKEN_SID_INVALID");uint size=GetLengthSid(sid);Need(size>=8&&size<=length-(point-start),"TOKEN_SID_INVALID");return new SecurityIdentifier(sid).Value;}
  SortedDictionary<string,object> VerifyToken(IntPtr process,IntPtr job){
    IntPtr token;Win(OpenProcessToken(process,QueryToken|DuplicateToken,out token),"TOKEN_OPEN_FAILED");
    SortedDictionary<string,object> r=new SortedDictionary<string,object>(StringComparer.Ordinal);
    try{
      Need(TokenSid(token,1)==owner,"TOKEN_OWNER_MISMATCH");
      Need(Scalar(token,8)==1&&Scalar(token,29)==1,"TOKEN_LPAC_MISMATCH");
      int n;IntPtr p=TokenData(token,31,out n);string sid;
      try{sid=SidFromBuffer(p,n);}finally{Marshal.FreeHGlobal(p);}
      Need(sid==profileSid,"TOKEN_PROFILE_MISMATCH");
      p=TokenData(token,25,out n);try{Need(SidFromBuffer(p,n)=="S-1-16-4096","TOKEN_INTEGRITY_MISMATCH");}finally{Marshal.FreeHGlobal(p);}
      p=TokenData(token,30,out n);try{Need(n>=4&&Marshal.ReadInt32(p)==0,"TOKEN_CAPABILITIES_MISMATCH");}finally{Marshal.FreeHGlobal(p);}
      bool inJob;Win(IsProcessInJob(process,job,out inJob),"JOB_MEMBERSHIP_QUERY_FAILED");Need(inJob,"JOB_MEMBERSHIP_MISMATCH");
      r["appContainerSid"]=sid;r["ownerSidMatched"]=true;r["capabilityCount"]=0;r["lowIntegrity"]=true;r["primaryToken"]=true;
      SortedDictionary<string,object> restrictions=QueryRestrictions(token);r["hasRestrictions"]=(bool)restrictions["value"];r["hasRestrictionsQuery"]=restrictions;
      r["validationMethod"]=LpacAccessMethod;r["referenceRevision"]=LpacAccessRevision;
      r["ownerControl"]=LpacOwnerControl(owner);r["lpacAccess"]=LpacAccess(token,2);
      r["class46"]=SupplementalLpacQuery(token);r["lpac"]=true;
    }finally{Need(CloseHandle(token),"TOKEN_CLOSE_UNKNOWN");}
    if(!result.ContainsKey("lpacTokenProof"))result["lpacTokenProof"]=r;
    return r;
  }
  static bool CanonicalSidText(string value){
    if(String.IsNullOrEmpty(value))return false;
    try{return new SecurityIdentifier(value).Value==value;}catch(ArgumentException){return false;}
  }
  static bool RegistryTokenMatches(string expectedOwner,string expectedProfile,string observedOwner,int appContainer,string observedProfile){
    return appContainer==1&&CanonicalSidText(expectedOwner)&&CanonicalSidText(expectedProfile)&&String.Equals(expectedOwner,observedOwner,StringComparison.Ordinal)&&String.Equals(expectedProfile,observedProfile,StringComparison.Ordinal);
  }
  static bool RegistryStoragePathMatches(string value,string expectedOwner){
    // The API chooses this profile's storage key; its path need not contain the
    // AppContainer SID. Accept only a bounded exact path in the verified owner
    // hive, retaining the original API result for the post-delete observation.
    if(!CanonicalSidText(expectedOwner)||String.IsNullOrEmpty(value)||value.Length>32766||value.IndexOf('\0')>=0||value.IndexOf('/')>=0)return false;
    string prefix="\\REGISTRY\\USER\\"+expectedOwner;
    if(!value.StartsWith(prefix+"\\",StringComparison.OrdinalIgnoreCase)&&!value.StartsWith(prefix+"_Classes\\",StringComparison.OrdinalIgnoreCase))return false;
    for(int i=0;i<value.Length;i++){
      if(Char.IsHighSurrogate(value[i])){if(++i>=value.Length||!Char.IsLowSurrogate(value[i]))return false;}
      else if(Char.IsLowSurrogate(value[i]))return false;
    }
    string[] parts=value.Split('\\');
    for(int i=1;i<parts.Length;i++)if(parts[i].Length==0||parts[i]=="."||parts[i]=="..")return false;
    return true;
  }
  string CaptureRegistry(IntPtr process){
    IntPtr token=IntPtr.Zero,imp=IntPtr.Zero,key=IntPtr.Zero;bool impersonating=false;
    try{
      Win(OpenProcessToken(process,QueryToken|DuplicateToken,out token),"REGISTRY_TOKEN_OPEN_FAILED");
      string tokenOwner=TokenSid(token,1);int appContainer=Scalar(token,29);string tokenProfile=TokenSid(token,31);
      Need(RegistryTokenMatches(owner,profileSid,tokenOwner,appContainer,tokenProfile),"REGISTRY_TOKEN_IDENTITY_MISMATCH");
      Win(DuplicateTokenEx(token,QueryToken|ImpersonateToken,IntPtr.Zero,2,2,out imp),"REGISTRY_TOKEN_DUPLICATE_FAILED");
      Win(ImpersonateLoggedOnUser(imp),"REGISTRY_IMPERSONATION_FAILED");impersonating=true;ownerContext=false;
      int hr=GetAppContainerRegistryLocation(0x20019,out key);Need(hr==0&&key!=IntPtr.Zero,"REGISTRY_STORAGE_UNAVAILABLE",hr);
      uint needed;int status=NtQueryKey(key,3,IntPtr.Zero,0,out needed);
      Need((status==unchecked((int)0xc0000023)||status==unchecked((int)0x80000005))&&needed>=6&&needed<=65536,"REGISTRY_IDENTITY_UNAVAILABLE",status);
      IntPtr b=Marshal.AllocHGlobal((int)needed);
      try{
        uint got;status=NtQueryKey(key,3,b,needed,out got);Need(status==0&&got<=needed&&got>=6,"REGISTRY_IDENTITY_UNAVAILABLE",status);
        int bytes=Marshal.ReadInt32(b);Need(bytes>0&&bytes%2==0&&bytes<=got-4,"REGISTRY_IDENTITY_INVALID");
        string value=Marshal.PtrToStringUni(IntPtr.Add(b,4),bytes/2);
        Need(RegistryStoragePathMatches(value,owner),"REGISTRY_IDENTITY_MISMATCH");return value;
      }finally{Marshal.FreeHGlobal(b);}
    }finally{
      if(key!=IntPtr.Zero)RegCloseKey(key);
      if(impersonating){if(!RevertToSelf()){ownerContext=false;Environment.FailFast("W0_OWNER_CONTEXT_RESTORE_FAILED");}ownerContext=true;}
      if(imp!=IntPtr.Zero)CloseHandle(imp);if(token!=IntPtr.Zero)CloseHandle(token);
    }
  }
  static bool RegistryAbsent(string path){IntPtr text=Marshal.StringToHGlobalUni(path),name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US))),key=IntPtr.Zero;try{US u=new US();u.Buffer=text;u.Length=checked((ushort)(path.Length*2));u.Maximum=checked((ushort)(u.Length+2));Marshal.StructureToPtr(u,name,false);OA a=new OA();a.Length=(uint)Marshal.SizeOf(typeof(OA));a.Name=name;a.Attributes=0x40;int s=NtOpenKey(out key,0x20019,ref a);if(s==unchecked((int)0xc0000034)||s==unchecked((int)0xc000003a))return true;Need(s==0,"REGISTRY_ABSENCE_UNKNOWN",s);return false;}finally{if(key!=IntPtr.Zero)NtClose(key);Marshal.FreeHGlobal(name);Marshal.FreeHGlobal(text);}}
  bool EmptyJob(IntPtr job,int ms){IntPtr b=Marshal.AllocHGlobal(48);Stopwatch t=Stopwatch.StartNew();try{while(t.ElapsedMilliseconds<ms){Win(QueryInformationJobObject(job,1,b,48,IntPtr.Zero),"JOB_QUERY_FAILED");if(Marshal.ReadInt32(b,40)==0)return true;Thread.Sleep(20);}return false;}finally{Marshal.FreeHGlobal(b);}}
  static string Quote(string text){Need(text.IndexOf('"')<0&&text.IndexOf('\0')<0,"PATH_REJECTED");return "\""+text+"\"";}
  IntPtr EnvironmentBlock(){return BuildEnvironmentBlock(false);}
  IntPtr IdentityEnvironmentBlock(){return BuildEnvironmentBlock(true);}
  IntPtr BuildEnvironmentBlock(bool activationLog){
    string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    SortedDictionary<string,string> e=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    e["SystemRoot"]=windows;e["WINDIR"]=windows;
    e["PATH"]=Path.Combine(root,"runtime")+";"+Path.Combine(windows,"System32");
    e["USERPROFILE"]=profileFolder;e["HOME"]=profileFolder;e["APPDATA"]=profileFolder;e["LOCALAPPDATA"]=profileFolder;
    e["TEMP"]=Path.Combine(root,"tmp");e["TMP"]=Path.Combine(root,"tmp");e["CLAUDE_CONFIG_DIR"]=profileFolder;
    // Fixed Desktop CLR compatibility candidate for the trusted AMD64 fixture.
    // Neither request data nor ambient COMPLUS_* may choose a runtime location.
    e["COMPLUS_InstallRoot"]=Path.Combine(windows,"Microsoft.NET","Framework64")+Path.DirectorySeparatorChar;
    e["COMPLUS_Version"]="v4.0.30319";
    if(activationLog)e["COMPLUS_CLRLoadLogDir"]=Path.Combine(root,"tmp");
    StringBuilder b=new StringBuilder();foreach(KeyValuePair<string,string> p in e)b.Append(p.Key).Append('=').Append(p.Value).Append('\0');
    b.Append('\0');return Marshal.StringToHGlobalUni(b.ToString());
  }
  static bool ClrLogName(string name){return name!=null&&Regex.IsMatch(name,"\\Aclaude-lpac-fixture\\.exe\\.CLRLoad[0-9]{2}\\.log\\z",RegexOptions.CultureInvariant);}
  static string ClrLogPath(string directory,string path){
    Need(path!=null&&path.Length>=3&&path.IndexOf(':',2)<0,"CLR_LOG_PATH_REJECTED");
    string full=Absolute(path);
    Need(String.Equals(Path.GetDirectoryName(full),directory,StringComparison.Ordinal)&&ClrLogName(Path.GetFileName(full)),"CLR_LOG_PATH_REJECTED");return full;
  }
  static int ClrLogLength(long length,int count,long total){
    Need(count>=0&&count<2,"CLR_LOG_COUNT_LIMIT");
    Need(length>=0&&length<=65536,"CLR_LOG_FILE_SIZE_LIMIT");
    Need(total>=0&&total<=131072-length,"CLR_LOG_TOTAL_SIZE_LIMIT");return (int)length;
  }
  static void ClrLogFileShape(uint attributes,uint links){Need((attributes&0x410)==0&&links==1,"CLR_LOG_FILE_TYPE_REJECTED");}
  static SortedDictionary<string,object> ReadClrLog(string directory,string path,int count,long total){
    path=ClrLogPath(directory,path);
    using(HeldFile file=new HeldFile(path)){
      IntPtr handle=file.Stream.SafeFileHandle.DangerousGetHandle();FI before;Win(GetFileInformationByHandle(handle,out before),"CLR_LOG_IDENTITY_QUERY_FAILED");
      ClrLogFileShape(before.Attributes,before.Links);int length=ClrLogLength(file.Stream.Length,count,total);
      byte[] data=new byte[length];int read=0;while(read<length){int n=file.Stream.Read(data,read,length-read);Need(n>0,"CLR_LOG_READ_INCOMPLETE");read+=n;}
      Need(file.Stream.ReadByte()==-1,"CLR_LOG_FILE_CHANGED");FI after;Win(GetFileInformationByHandle(handle,out after),"CLR_LOG_IDENTITY_QUERY_FAILED");
      ClrLogFileShape(after.Attributes,after.Links);
      Need(IdentityOf(before)==file.Identity&&IdentityOf(after)==file.Identity&&file.Stream.Length==length&&Final(handle)==path,"CLR_LOG_FILE_CHANGED");
      string sha;using(MemoryStream bytes=new MemoryStream(data,false))sha=Digest(bytes);
      var row=new SortedDictionary<string,object>(StringComparer.Ordinal);
      row["sourceBasename"]=Path.GetFileName(path);row["sourceFileId"]=file.Identity;row["bytes"]=length;row["sha256"]=sha;row["rawBase64"]=Convert.ToBase64String(data);return row;
    }
  }
  SortedDictionary<string,object> CollectClrActivationLogs(){
    Need(ownerContext&&jobEmpty,"CLR_LOG_JOB_NOT_EMPTY");
    Need(rootIdentity!=null&&IdentityOf(DirectoryInfo(root))==rootIdentity,"CLR_LOG_ROOT_CHANGED");
    string directory=Path.Combine(root,"tmp");Need(OwnerOf(directory,true)==owner,"CLR_LOG_OWNER_CHANGED");
    FI info=DirectoryInfo(directory);
    using(HubPinnedRoot logPin=new HubPinnedRoot(directory,Fingerprint(directory,info))){
      foreach(HubPinnedRoot pin in pins)pin.Verify();
      string[] entries=Directory.GetFileSystemEntries(directory);Need(entries.Length<=64,"CLR_LOG_DIRECTORY_ENTRY_LIMIT");
      List<string> paths=new List<string>();foreach(string path in entries)if(ClrLogName(Path.GetFileName(path)))paths.Add(ClrLogPath(directory,path));
      paths.Sort(StringComparer.Ordinal);Need(paths.Count<=2,"CLR_LOG_COUNT_LIMIT");
      List<object> logs=new List<object>();long totalBytes=0;
      foreach(string path in paths){var row=ReadClrLog(directory,path,logs.Count,totalBytes);totalBytes+=(int)row["bytes"];logs.Add(row);}
      logPin.Verify();foreach(HubPinnedRoot pin in pins)pin.Verify();
      Need(IdentityOf(DirectoryInfo(root))==rootIdentity,"CLR_LOG_ROOT_CHANGED");
      return ClrLogDiagnostic(logs.Count==0?"absent":"captured",logs.Count==0?"CLR_LOGS_ABSENT":"CLR_LOGS_CAPTURED",logs);
    }
  }
  static SortedDictionary<string,object> ClrLogDiagnostic(string status,string code,List<object> logs){
    var r=new SortedDictionary<string,object>(StringComparer.Ordinal);r["schemaVersion"]=1;r["scope"]="identity-child-owned-tmp";
    r["status"]=status;r["code"]=code;r["interpretation"]="diagnostic-only-not-root-cause-or-pass";r["logs"]=logs;return r;
  }
  void CaptureClrActivationLogs(){
    // Diagnostic failures never replace the fixture failure or suppress Cleanup.
    // No raw bytes are published if any file/root/limit check fails.
    try{result["clrActivationLogs"]=CollectClrActivationLogs();}
    catch(Rejected error){result["clrActivationLogs"]=ClrLogDiagnostic("error",error.Code,new List<object>());}
    catch(Exception){result["clrActivationLogs"]=ClrLogDiagnostic("error","CLR_LOG_COLLECTION_FAILED",new List<object>());}
  }
  sealed class Capture {
    public readonly MemoryStream Bytes=new MemoryStream();
    public volatile bool Failed,Exceeded;
    public Thread Thread;
    // The reader owns only its pipe. It must never retain a borrowed Job HANDLE:
    // bounded Join may time out before the controller closes/reuses that HANDLE.
    public void Start(IntPtr handle){
      Thread=new Thread(delegate(){
        using(FileStream stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read)){
          byte[] b=new byte[4096];
          try{int n;while((n=stream.Read(b,0,b.Length))>0){
            if(Bytes.Length+n>MaxOutput){Exceeded=true;break;}
            Bytes.Write(b,0,n);
          }}catch{Failed=true;}
        }
      });
      Thread.IsBackground=true;Thread.Start();
    }
  }
  // A fresh Job per fixed case; no caller-controlled executable/argv/env surface.
  void RunIdentity(){IntPtr job=IntPtr.Zero,attrs=IntPtr.Zero,handleList=IntPtr.Zero,caps=IntPtr.Zero,policy=IntPtr.Zero,env=IntPtr.Zero;IntPtr[] pipes=new IntPtr[6];PI process=new PI();Capture stdout=null,stderr=null;HeldFile executable=null;bool launched=false;try{job=CreateJobObject(IntPtr.Zero,IntPtr.Zero);Win(job!=IntPtr.Zero,"JOB_CREATE_FAILED");XL limits=new XL();limits.Basic.Flags=JobFlags;limits.Basic.Active=8;limits.Basic.JobTime=50000000;limits.JobMemory=new UIntPtr(512U*1024U*1024U);Win(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(XL))),"JOB_LIMIT_SET_FAILED");IntPtr q=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(XL)));try{Win(QueryInformationJobObject(job,9,q,(uint)Marshal.SizeOf(typeof(XL)),IntPtr.Zero),"JOB_LIMIT_QUERY_FAILED");XL observed=(XL)Marshal.PtrToStructure(q,typeof(XL));Need(observed.Basic.Flags==JobFlags&&observed.Basic.Active==8&&observed.Basic.JobTime==50000000&&observed.JobMemory.ToUInt64()==512UL*1024*1024,"JOB_LIMIT_MISMATCH");}finally{Marshal.FreeHGlobal(q);}SA sa=new SA();sa.Size=Marshal.SizeOf(typeof(SA));sa.Inherit=1;Win(CreatePipe(out pipes[0],out pipes[1],ref sa,4096),"PIPE_CREATE_FAILED");Win(CreatePipe(out pipes[2],out pipes[3],ref sa,4096),"PIPE_CREATE_FAILED");Win(CreatePipe(out pipes[4],out pipes[5],ref sa,4096),"PIPE_CREATE_FAILED");foreach(int i in new int[]{1,2,4})Win(SetHandleInformation(pipes[i],1,0),"PIPE_INHERITANCE_FAILED");SIX si=new SIX();si.Info.Size=Marshal.SizeOf(typeof(SIX));si.Info.Flags=0x100;si.Info.Input=pipes[0];si.Info.Output=pipes[3];si.Info.Error=pipes[5];IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref size);Need(size.ToInt64()>0&&size.ToInt64()<65536,"ATTRIBUTE_SIZE_INVALID");attrs=Marshal.AllocHGlobal(size);Win(InitializeProcThreadAttributeList(attrs,3,0,ref size),"ATTRIBUTE_INIT_FAILED");handleList=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handleList,pipes[0]);Marshal.WriteIntPtr(handleList,IntPtr.Size,pipes[3]);Marshal.WriteIntPtr(handleList,IntPtr.Size*2,pipes[5]);Win(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"ATTRIBUTE_HANDLES_FAILED");SC sc=new SC();sc.Sid=expectedSid;caps=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SC)));Marshal.StructureToPtr(sc,caps,false);Win(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf(typeof(SC))),IntPtr.Zero,IntPtr.Zero),"ATTRIBUTE_CAPABILITIES_FAILED");policy=Marshal.AllocHGlobal(4);Marshal.WriteInt32(policy,1);Win(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000f),policy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero),"ATTRIBUTE_LPAC_FAILED");si.Attributes=attrs;env=IdentityEnvironmentBlock();executable=new HeldFile(fixtureFile);Need(Digest(executable.Stream)==fixtureHash,"FIXTURE_BYTES_CHANGED");Win(CreateProcess(fixtureFile,new StringBuilder(Quote(fixtureFile)),IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,Path.Combine(root,"task"),ref si,out process),"FIXTURE_CREATE_FAILED");launched=true;jobEmpty=false;try{Win(AssignProcessToJobObject(job,process.Process),"JOB_ASSIGN_FAILED");}catch{TerminateProcess(process.Process,125);throw;}foreach(int i in new int[]{0,3,5}){CloseHandle(pipes[i]);pipes[i]=IntPtr.Zero;}VerifyProfileToken(process.Process);registryPath=CaptureRegistry(process.Process);registryCaptured=true;SortedDictionary<string,object> token=VerifyToken(process.Process,job);Record("registry-storage-identified","registryStorage",registryPath,"token",token);stage="boundary-verified";Record("boundary-verified","jobLimitsVerified",true,"capabilityCount",0,"lpac",true);foreach(HubPinnedRoot pin in pins)pin.Verify();using(HeldFile held=new HeldFile(fixtureFile)){Need(Digest(held.Stream)==fixtureHash,"FIXTURE_BYTES_CHANGED");stage="probing";Record("identity-starting","pid",process.Pid);stdout=new Capture();stdout.Start(pipes[2]);pipes[2]=IntPtr.Zero;stderr=new Capture();stderr.Start(pipes[4]);pipes[4]=IntPtr.Zero;Win(ResumeThread(process.Thread)!=0xffffffff,"FIXTURE_RESUME_FAILED");using(FileStream input=new FileStream(new SafeFileHandle(pipes[1],true),FileAccess.Write)){pipes[1]=IntPtr.Zero;byte[] request=Utf8.GetBytes("HUB-LPAC-W0\t1\t"+nonce+"\tidentity\n");input.Write(request,0,request.Length);input.Flush();}Stopwatch wall=Stopwatch.StartNew();uint wait;do{wait=WaitForSingleObject(process.Process,25);Need(wait==0||wait==258,"FIXTURE_WAIT_FAILED");Need(!stdout.Exceeded&&!stderr.Exceeded,"FIXTURE_OUTPUT_LIMIT");Need(!stdout.Failed&&!stderr.Failed,"FIXTURE_OUTPUT_FAILED");Need(wall.ElapsedMilliseconds<20000&&total.ElapsedMilliseconds<360000,"FIXTURE_WALL_LIMIT");CheckBudget();}while(wait==258);uint exit;Win(GetExitCodeProcess(process.Process,out exit),"FIXTURE_EXIT_FAILED");result["fixtureExitCode"]=exit;Need(stdout.Thread.Join(3000)&&stderr.Thread.Join(3000)&&!stdout.Failed&&!stderr.Failed&&!stdout.Exceeded&&!stderr.Exceeded,"FIXTURE_OUTPUT_INCOMPLETE");result["stdoutBytes"]=stdout.Bytes.Length;result["stderrBytes"]=stderr.Bytes.Length;string text=Utf8.GetString(stdout.Bytes.ToArray());Record("fixture-returned","exitCode",exit,"stdoutBytes",stdout.Bytes.Length,"stderrBytes",stderr.Bytes.Length);Need(exit==0&&text=="HUB-LPAC-W0\t1\t"+nonce+"\tidentity\tready\n"&&stderr.Bytes.Length==0,"FIXTURE_BOOTSTRAP_INCOMPATIBLE");bootstrapPassed=true;Record("identity-passed","exitCode",exit,"stdoutBytes",stdout.Bytes.Length,"stderrBytes",stderr.Bytes.Length,"durationMs",wall.ElapsedMilliseconds);}}catch{failureStage=stage;throw;}finally{stage="stopping";if(job!=IntPtr.Zero){bool killed=TerminateJobObject(job,125);try{jobEmpty=(!launched||killed)&&EmptyJob(job,5000);}catch{jobEmpty=false;}}if(process.Process!=IntPtr.Zero){if(!jobEmpty)TerminateProcess(process.Process,125);uint wait=WaitForSingleObject(process.Process,3000);if(wait!=0)jobEmpty=false;}foreach(IntPtr p in pipes)if(p!=IntPtr.Zero)CloseHandle(p);if(stdout!=null&&stdout.Thread!=null&&!stdout.Thread.Join(1000))jobEmpty=false;if(stderr!=null&&stderr.Thread!=null&&!stderr.Thread.Join(1000))jobEmpty=false;if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);if(process.Process!=IntPtr.Zero)CloseHandle(process.Process);if(executable!=null)executable.Dispose();if(job!=IntPtr.Zero)CloseHandle(job);if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}foreach(IntPtr p in new IntPtr[]{handleList,caps,policy,env})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);if(ownerContext)Record("job-stopped","jobEmpty",jobEmpty);if(launched)CaptureClrActivationLogs();}}
  void Prepare(Dictionary<string,object> request){Need(request!=null&&request.Count==6&&request.ContainsKey("schemaVersion")&&request["schemaVersion"] is int&&(int)request["schemaVersion"]==1&&request.ContainsKey("operation")&&(string)request["operation"]=="claude-lpac-bootstrap-gate","REQUEST_REJECTED");foreach(string k in new string[]{"runNonce","rootParent","fixturePath","fixtureSHA256"})Need(request.ContainsKey(k)&&request[k] is string,"REQUEST_REJECTED");string candidateNonce=(string)request["runNonce"],candidateHash=(string)request["fixtureSHA256"];Need(NoncePattern.IsMatch(candidateNonce)&&HashPattern.IsMatch(candidateHash),"REQUEST_REJECTED");nonce=candidateNonce;parent=Absolute((string)request["rootParent"]);string source=Absolute((string)request["fixturePath"]);Need(Path.GetFileName(source)=="claude-lpac-fixture.exe","FIXTURE_NAME_REJECTED");fixtureHash=candidateHash;owner=WindowsIdentity.GetCurrent().User.Value;PinDirectory(parent);Need(new DriveInfo(Path.GetPathRoot(parent)).AvailableFreeSpace>=201326592,"DISK_ADMISSION_SHORTFALL");using(HeldFile held=new HeldFile(source)){Need(held.Stream.Length>0&&held.Stream.Length<=4*1024*1024&&Digest(held.Stream)==fixtureHash,"FIXTURE_SOURCE_REJECTED");root=Path.Combine(parent,"HubLpacW0-"+nonce);journalPath=Path.Combine(parent,"HubLpacW0-"+nonce+".journal.jsonl");Need(Absent(root)&&Absent(journalPath),"ATTEMPT_ALREADY_EXISTS");MakeDirectory(root);rootIdentity=IdentityOf(DirectoryInfo(root));PinDirectory(root);foreach(string name in new string[]{"controller","runtime","task","tmp","outside-canary","other-task","fake-auth"}){MakeDirectory(Path.Combine(root,name));PinDirectory(Path.Combine(root,name));}profileName="ProjectHub.ClaudeProbe."+Guid.NewGuid().ToString("N");int hr=DeriveAppContainerSidFromAppContainerName(profileName,out expectedSid);Need(hr==0&&expectedSid!=IntPtr.Zero&&IsValidSid(expectedSid),"PROFILE_SID_DERIVE_FAILED",hr);profileSid=new SecurityIdentifier(expectedSid).Value;FileSecurity security=new FileSecurity();security.SetSecurityDescriptorSddlForm("O:"+owner+"D:P(A;;FA;;;"+owner+")");journal=new FileStream(journalPath,FileMode.CreateNew,FileSystemRights.Write|FileSystemRights.ReadPermissions,FileShare.Read,4096,FileOptions.WriteThrough,security);Record("creation-intended","profileName",profileName,"expectedSid",profileSid,"ownerSid",owner,"root",root,"rootIdentity",rootIdentity,"expectedProfileAbsent",true,"fixtureIdentity",held.Identity,"fixtureSHA256",fixtureHash);IntPtr actual=IntPtr.Zero;try{creationAttempted=true;hr=CreateAppContainerProfile(profileName,profileName,"Project Hub W0 synthetic bootstrap; no provider/auth/network",IntPtr.Zero,0,out actual);if(hr==unchecked((int)0x800700b7))creationOutcomeKnown=true;Need(hr==0,"PROFILE_CREATE_FAILED",hr);created=true;creationOutcomeKnown=true;Need(actual!=IntPtr.Zero&&IsValidSid(actual)&&new SecurityIdentifier(actual).Value==profileSid,"PROFILE_SID_MISMATCH");IntPtr path;hr=GetAppContainerFolderPath(profileSid,out path);Need(hr==0&&path!=IntPtr.Zero,"PROFILE_FOLDER_UNAVAILABLE",hr);try{profileFolder=Absolute(Marshal.PtrToStringUni(path));}finally{Marshal.FreeCoTaskMem(path);}Need(OwnerOf(profileFolder,true)==owner,"PROFILE_OWNER_MISMATCH");FI f=DirectoryInfo(profileFolder);profileIdentity=IdentityOf(f);profilePin=new HubPinnedRoot(profileFolder,Fingerprint(profileFolder,f));stage="profile-created";Record("profile-created","profileName",profileName,"appContainerSid",profileSid,"profileFolder",profileFolder,"profileIdentity",profileIdentity,"registryStorageStatus","not-yet-identified");createdReceipt=true;}finally{if(actual!=IntPtr.Zero)FreeSid(actual);}SetAcl(root,"0x1200a9",true,false);SetAcl(Path.Combine(root,"runtime"),"0x1200a9",true,false);foreach(string name in new string[]{"task","tmp"})SetAcl(Path.Combine(root,name),"0x1301bf",true,true);fixtureFile=Path.Combine(root,"runtime","claude-lpac-fixture.exe");held.Stream.Position=0;using(FileStream target=new FileStream(fixtureFile,FileMode.CreateNew,FileAccess.Write,FileShare.None)){held.Stream.CopyTo(target);target.Flush(true);}SetAcl(fixtureFile,"0x1200a9",false,false);using(HeldFile verify=new HeldFile(fixtureFile))Need(Digest(verify.Stream)==fixtureHash,"FIXTURE_COPY_MISMATCH");PinDirectory(root);PinDirectory(Path.Combine(root,"runtime"));Record("fixture-prepared","fixtureSHA256",fixtureHash);CheckBudget();}}
  void DeleteOwnedTree(string path,bool isRoot,int depth){
    Need(depth<=16,"CLEANUP_DEPTH_LIMIT");
    Need(ownerContext&&(path.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)||path==root),"CLEANUP_PATH_REJECTED");
    Need(OwnerOf(path,true)==owner,"CLEANUP_OWNER_CHANGED");FI before=DirectoryInfo(path);
    if(isRoot)Need(IdentityOf(before)==rootIdentity,"CLEANUP_ROOT_CHANGED");
    using(HubPinnedRoot held=new HubPinnedRoot(path,Fingerprint(path,before))){
      string[] children=Directory.GetFileSystemEntries(path);Need(children.Length<=64,"CLEANUP_ENTRY_LIMIT");
      foreach(string child in children){
        uint attr=GetFileAttributes(child);Need(attr!=0xffffffff&&(attr&0x400)==0,"CLEANUP_TYPE_REJECTED");
        if((attr&0x10)!=0){Need(!isRoot||Array.IndexOf(new string[]{"controller","runtime","task","tmp","outside-canary","other-task","fake-auth"},Path.GetFileName(child))>=0,"CLEANUP_LAYOUT_CHANGED");DeleteOwnedTree(child,false,depth+1);}
        else{Need(OwnerOf(child,false)==owner,"CLEANUP_OWNER_CHANGED");DeleteHeld(child,false,null);}
      }
      held.Verify();
    }
    DeleteHeld(path,true,IdentityOf(before));
  }
  static void DeleteHeld(string path,bool directory,string identity){IntPtr h=CreateFile(path,0x10080,0,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Need(h!=new IntPtr(-1),"CLEANUP_OPEN_FAILED",Marshal.GetLastWin32Error());try{FI f;Win(GetFileInformationByHandle(h,out f),"CLEANUP_IDENTITY_FAILED");Need((f.Attributes&0x400)==0&&((f.Attributes&0x10)!=0)==directory&&Final(h)==path&&(directory||f.Links==1)&&(identity==null||IdentityOf(f)==identity),"CLEANUP_IDENTITY_CHANGED");DISPOSITION d=new DISPOSITION();d.Delete=1;Win(SetFileInformationByHandle(h,4,ref d,1),"CLEANUP_DELETE_FAILED");}finally{CloseHandle(h);}Need(Absent(path),"CLEANUP_POSTCONDITION_FAILED");}
  void Cleanup(){
    cleanupVerified=false;
    Need(ownerContext,"OWNER_CONTEXT_UNKNOWN");stage="cleaning";bool safe=jobEmpty;
    Record("cleanup-starting","jobEmpty",jobEmpty,"profileCreated",created,"creationAttempted",creationAttempted,"creationOutcomeKnown",creationOutcomeKnown);
    Need(!creationAttempted||creationOutcomeKnown,"PROFILE_CREATION_OUTCOME_UNKNOWN");
    if(created)Need(createdReceipt&&safe&&profileFolder!=null&&OwnerOf(profileFolder,true)==owner&&IdentityOf(DirectoryInfo(profileFolder))==profileIdentity,"PROFILE_CLEANUP_OWNERSHIP_UNKNOWN");
    if(profilePin!=null){profilePin.Dispose();profilePin=null;}
    if(created){
      int hr=DeleteAppContainerProfile(profileName);Record("profile-delete-result","hresult",hr);
      Need(hr==0,"PROFILE_DELETE_FAILED",hr);Need(Absent(profileFolder),"PROFILE_FOLDER_REMAINS");
      Need(registryCaptured&&RegistryAbsent(registryPath),"PROFILE_REGISTRY_CLEANUP_UNKNOWN");
      Record("profile-cleanup-verified","folderAbsent",true,"registryStorageAbsent",true);
    }
    Need(safe,"JOB_CLEANUP_UNKNOWN");
    for(int i=pins.Count-1;i>=1;i--){pins[i].Dispose();pins.RemoveAt(i);}
    if(root!=null&&!Absent(root))DeleteOwnedTree(root,true,0);
    Record("cleanup-verified","tempAbsent",root==null||Absent(root));
    stage="closed";
    try{Record("closed","bootstrapPassed",bootstrapPassed,"probePassed",false,"providerReady",false);}
    catch{stage="cleaning";throw;}
    // Record() appends to events only after its write and durable Flush(true).
    // A failed receipt must never publish cleanupVerified or a successful exit.
    cleanupVerified=true;
  }
  void CleanupFailed(string code,int native){
    cleanupVerified=false;if(stage=="closed")stage="cleaning";
    if(!result.ContainsKey("cleanupCode")){result["cleanupCode"]=code;result["cleanupNativeCode"]=native;}
  }
  static int ResultExitCode(string code,bool bootstrap,bool suite,bool cleanup,bool cleanupError,string phase){
    return code=="W0_NATIVE_CASES_PASSED"&&bootstrap&&suite&&cleanup&&!cleanupError&&phase=="closed"?0:1;
  }
  int Execute(Dictionary<string,object> request){
    string code="W0_BOOTSTRAP_NOT_MEASURED";int native=0;
    try{Prepare(request);RunIdentity();RunSuiteCases();code=suiteComplete?"W0_NATIVE_CASES_PASSED":"W0_NATIVE_CASES_INCOMPLETE";}
    catch(Rejected e){code=e.Code;native=e.Native;if(ownerContext&&journal!=null)try{Record("gate-failed","code",code,"nativeCode",native,"failedAt",failureStage??stage);}catch{}}
    catch(Exception){code="W0_INTERNAL_FAILURE";if(ownerContext&&journal!=null)try{Record("gate-failed","code",code,"failedAt",failureStage??stage);}catch{}}
    finally{
      try{if(journal!=null||rootIdentity!=null)Cleanup();}
      catch(Rejected e){CleanupFailed(e.Code,e.Native);}
      catch{CleanupFailed("CLEANUP_UNKNOWN",0);}
      foreach(HubPinnedRoot p in pins)try{p.Dispose();}catch{CleanupFailed("CLEANUP_HANDLE_UNKNOWN",0);}
      pins.Clear();
      try{if(profilePin!=null)profilePin.Dispose();}catch{CleanupFailed("CLEANUP_HANDLE_UNKNOWN",0);}
      if(expectedSid!=IntPtr.Zero)FreeSid(expectedSid);
      // A final FileStream disposal failure is also an uncertain receipt; do
      // not let it escape into Main's pre-admission rejected response.
      try{if(journal!=null)journal.Dispose();}catch{CleanupFailed("CLEANUP_JOURNAL_CLOSE_UNKNOWN",0);}
    }
    if(code=="W0_NATIVE_CASES_PASSED"&&result.ContainsKey("cleanupCode"))code=(string)result["cleanupCode"];
    result["schemaVersion"]=1;result["operation"]="claude-lpac-bootstrap-gate";result["stage"]=stage;result["code"]=code;result["nativeCode"]=native;result["runNonce"]=nonce;result["root"]=root;result["journalPath"]=journalPath;result["profileName"]=profileName;result["profileFolder"]=profileFolder;result["registryStorage"]=registryPath;result["profileCreated"]=creationAttempted&&!creationOutcomeKnown?(object)null:created;result["creationAttempted"]=creationAttempted;result["creationOutcomeKnown"]=creationOutcomeKnown;result["bootstrapPassed"]=bootstrapPassed;result["cleanupVerified"]=cleanupVerified;result["probePassed"]=false;result["providerReady"]=false;result["modelCalled"]=false;result["authRead"]=false;result["networkProbed"]=suiteNetworkProbed;result["syntheticSuiteComplete"]=suiteComplete;result["wholeProcessIsolationVerified"]=false;result["diskQuotaEnforced"]=false;result["events"]=events;result["cases"]=GetSuiteCases();
    Console.WriteLine(new JavaScriptSerializer().Serialize(result));
    return ResultExitCode(code,bootstrapPassed,suiteComplete,cleanupVerified,result.ContainsKey("cleanupCode"),stage);
  }
  // This request is a flat six-field object. Parse before invoking any OS
  // mutation; JavaScriptSerializer alone would silently overwrite duplicates.
  sealed class RequestReader {
    readonly string source;int at;
    public RequestReader(string text){source=text;Need(text.Length>0&&text.IndexOf('\0')<0,"REQUEST_REJECTED");Utf8.GetByteCount(text);}
    void Space(){while(at<source.Length&&" \r\n\t".IndexOf(source[at])>=0)at++;}
    void Take(char c){Space();Need(at<source.Length&&source[at++]==c,"REQUEST_REJECTED");}
    string String(){Space();int start=at;Need(at<source.Length&&source[at++]=='"',"REQUEST_REJECTED");bool done=false;while(at<source.Length){char c=source[at++];Need(c>=32,"REQUEST_REJECTED");if(c=='"'){done=true;break;}if(c=='\\'){Need(at<source.Length,"REQUEST_REJECTED");char e=source[at++];Need("\"\\/bfnrtu".IndexOf(e)>=0,"REQUEST_REJECTED");if(e=='u')for(int i=0;i<4;i++){Need(at<source.Length&&Uri.IsHexDigit(source[at]),"REQUEST_REJECTED");at++;}}}Need(done,"REQUEST_REJECTED");string value=new JavaScriptSerializer().Deserialize<string>(source.Substring(start,at-start));Need(value.IndexOf('\0')<0,"REQUEST_REJECTED");Utf8.GetByteCount(value);return value;}
    public Dictionary<string,object> Read(){Take('{');var values=new Dictionary<string,object>(StringComparer.Ordinal);for(int i=0;i<6;i++){if(i>0)Take(',');string key=String();Need(!values.ContainsKey(key)&&Array.IndexOf(new string[]{"schemaVersion","operation","runNonce","rootParent","fixturePath","fixtureSHA256"},key)>=0,"REQUEST_REJECTED");Take(':');if(key=="schemaVersion"){Space();Need(at<source.Length&&source[at++]=='1',"REQUEST_REJECTED");values.Add(key,1);}else values.Add(key,String());}Take('}');Space();Need(at==source.Length,"REQUEST_REJECTED");return values;}
  }
  static void Passive(string code,string state,int native,bool describe){var r=new SortedDictionary<string,object>();r["schemaVersion"]=1;r["operation"]="claude-lpac-bootstrap-gate";r["stage"]=state;r["code"]=code;r["nativeCode"]=native;r["providerReady"]=false;r["probePassed"]=false;r["bootstrapPassed"]=false;r["cleanupVerified"]=true;r["profileCreated"]=false;if(describe){r["executionSwitch"]="--execute-approved-w0-gate";r["runNonceFormat"]="32 lowercase hex";r["fixtureName"]="claude-lpac-fixture.exe";}Console.WriteLine(new JavaScriptSerializer().Serialize(r));}
  static int Main(string[] args){
    Console.OutputEncoding=Utf8;
    if(args.Length==0||args.Length==1&&args[0]=="--describe"){Passive("W0_CONTRACT_ONLY","inert",0,true);return 0;}
    if(args.Length!=1||args[0]!="--execute-approved-w0-gate"){Passive("EXECUTION_SWITCH_REQUIRED","rejected",0,false);return 2;}
    try{
      Need(IntPtr.Size==8,"UNSUPPORTED_PLATFORM");
      using(Stream input=Console.OpenStandardInput()){
        MemoryStream bytes=new MemoryStream();byte[] b=new byte[1024];int n;
        while((n=input.Read(b,0,b.Length))>0){Need(bytes.Length+n<=16384,"REQUEST_TOO_LARGE");bytes.Write(b,0,n);}
        return new HubClaudeLpacProbe().Execute(new RequestReader(Utf8.GetString(bytes.ToArray())).Read());
      }
    }catch(Rejected e){Passive(e.Code,"rejected",e.Native,false);return 2;}
    catch{Passive("REQUEST_REJECTED","rejected",0,false);return 2;}
  }
}
