// Exact-target Windows Credential Manager access for the SSH broker.
// Caller owns the registration lock and verifies SID, descriptor, code and roots.
// Generic credentials remain accessible to other programs running as this user.
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class HubSshVaultStore {
  const uint GENERIC=1, LOCAL_MACHINE=2, PACK_GENERIC=4;
  const int NOT_FOUND=1168, INSUFFICIENT_BUFFER=122, CANCELLED=1223;
  const int MAX_SECRET=2560, MAX_AUTH_BUFFER=1024*1024;
  const string PREFIX="ProjectHub.WorkerSshPassword.v1/";
  const string COMMENT="Project Hub SSH password v1";
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);

  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CREDENTIAL {
    public uint Flags,Type;
    public IntPtr TargetName,Comment;
    public FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist,AttributeCount;
    public IntPtr Attributes,TargetAlias,UserName;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct CREDUI_INFO {
    public uint Size;
    public IntPtr Parent;
    [MarshalAs(UnmanagedType.LPWStr)] public string Message;
    [MarshalAs(UnmanagedType.LPWStr)] public string Caption;
    public IntPtr Banner;
  }

  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr credential);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredWriteW(ref CREDENTIAL credential,uint flags);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredDeleteW(string target,uint type,uint flags);
  [DllImport("advapi32.dll",ExactSpelling=true)] static extern void CredFree(IntPtr credential);
  [DllImport("credui.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
  static extern uint CredUIPromptForWindowsCredentialsW(ref CREDUI_INFO info,uint error,ref uint package,IntPtr input,uint inputSize,out IntPtr output,out uint outputSize,[MarshalAs(UnmanagedType.Bool)] ref bool save,uint flags);
  [DllImport("credui.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredPackAuthenticationBufferW(uint flags,string user,IntPtr password,IntPtr packed,ref uint size);
  [DllImport("credui.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredUnPackAuthenticationBufferW(uint flags,IntPtr packed,uint size,IntPtr user,ref uint userChars,IntPtr domain,ref uint domainChars,IntPtr password,ref uint passwordChars);

  static InvalidOperationException Failure(string code) {return new InvalidOperationException(code);}
  static InvalidOperationException NativeFailure(string code,int error) {return Failure(code+"_"+error.ToString(CultureInfo.InvariantCulture));}
  static void Require(bool ok,string code) {if(!ok)throw Failure(code);}
  static void ValidateTarget(string target) {
    Require(target!=null&&target.StartsWith(PREFIX,StringComparison.Ordinal)&&target.Length==PREFIX.Length+36+1+64,"SSH_VAULT_TARGET_INVALID");
    string id=target.Substring(PREFIX.Length,36);Guid parsed;
    Require(Guid.TryParseExact(id,"D",out parsed)&&parsed!=Guid.Empty&&String.Equals(parsed.ToString("D"),id,StringComparison.Ordinal)&&target[PREFIX.Length+36]=='/',"SSH_VAULT_TARGET_INVALID");
    for(int i=PREFIX.Length+37;i<target.Length;i++)Require((target[i]>='0'&&target[i]<='9')||(target[i]>='a'&&target[i]<='f'),"SSH_VAULT_TARGET_INVALID");
  }
  static void ValidateUser(string user) {
    Require(!String.IsNullOrEmpty(user)&&user.Length<=256&&String.Equals(user,user.Trim(),StringComparison.Ordinal),"SSH_VAULT_USER_INVALID");
    foreach(char c in user)Require(c>=' '&&c!=127&&c!='/'&&c!='\\',"SSH_VAULT_USER_INVALID");
    try {Utf8.GetByteCount(user);}catch(EncoderFallbackException){throw Failure("SSH_VAULT_USER_INVALID");}
  }
  static void ValidateDisplay(string display) {
    Require(!String.IsNullOrEmpty(display)&&display.Length<=256,"SSH_VAULT_DISPLAY_INVALID");
    foreach(char c in display)Require(c>=' '&&c<='~',"SSH_VAULT_DISPLAY_INVALID");
  }
  static IntPtr AllocateZero(int size) {IntPtr p=Marshal.AllocHGlobal(size);Zero(p,size);return p;}
  static void Zero(IntPtr p,int size) {if(p!=IntPtr.Zero)for(int i=0;i<size;i++)Marshal.WriteByte(p,i,0);}
  static void ClearFree(IntPtr p,int size) {if(p!=IntPtr.Zero){Zero(p,size);Marshal.FreeHGlobal(p);}}
  static CREDENTIAL Structure(IntPtr p) {return (CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));}
  static void FreeCredential(IntPtr p) {
    if(p==IntPtr.Zero)return;
    try {CREDENTIAL c=Structure(p);if(c.CredentialBlob!=IntPtr.Zero&&c.CredentialBlobSize<=MAX_SECRET)Zero(c.CredentialBlob,(int)c.CredentialBlobSize);}
    finally {CredFree(p);}
  }
  static string BoundedString(IntPtr p,int max,string code) {
    Require(p!=IntPtr.Zero,code);
    for(int i=0;i<=max;i++)if(Marshal.ReadInt16(p,i*2)==0)return Marshal.PtrToStringUni(p,i);
    throw Failure(code);
  }
  static void CheckRecord(CREDENTIAL c,string target,string user) {
    Require(c.Type==GENERIC&&c.Flags==0&&c.Persist==LOCAL_MACHINE&&c.AttributeCount==0&&c.TargetAlias==IntPtr.Zero,"SSH_VAULT_METADATA_MISMATCH");
    Require(String.Equals(BoundedString(c.TargetName,32767,"SSH_VAULT_METADATA_MISMATCH"),target,StringComparison.Ordinal),"SSH_VAULT_METADATA_MISMATCH");
    Require(String.Equals(BoundedString(c.UserName,256,"SSH_VAULT_METADATA_MISMATCH"),user,StringComparison.Ordinal),"SSH_VAULT_USER_MISMATCH");
    Require(String.Equals(BoundedString(c.Comment,256,"SSH_VAULT_METADATA_MISMATCH"),COMMENT,StringComparison.Ordinal),"SSH_VAULT_METADATA_MISMATCH");
    Require(c.CredentialBlob!=IntPtr.Zero&&c.CredentialBlobSize>0&&c.CredentialBlobSize<=MAX_SECRET,"SSH_VAULT_SECRET_INVALID");
  }
  static IntPtr ReadNative(string target,bool missingAllowed) {
    IntPtr p;
    if(CredReadW(target,GENERIC,0,out p))return p;
    int error=Marshal.GetLastWin32Error();
    if(error==NOT_FOUND&&missingAllowed)return IntPtr.Zero;
    if(error==NOT_FOUND)throw Failure("SSH_VAULT_NOT_FOUND");
    throw NativeFailure("SSH_VAULT_READ_FAILED",error);
  }
  static bool EqualNative(CREDENTIAL c,byte[] secret) {
    if(c.CredentialBlobSize!=secret.Length)return false;
    int difference=0;
    for(int i=0;i<secret.Length;i++)difference|=Marshal.ReadByte(c.CredentialBlob,i)^secret[i];
    return difference==0;
  }

  // The returned byte array belongs to the caller, which must clear it in finally.
  // Validation never decodes a password into a managed immutable string.
  public static void Validate(byte[] secret) {
    Require(secret!=null&&secret.Length>0&&secret.Length<=MAX_SECRET,"SSH_VAULT_SECRET_INVALID");
    foreach(byte b in secret)Require(b!=0&&b!=10&&b!=13,"SSH_VAULT_SECRET_INVALID");
    try {Utf8.GetCharCount(secret,0,secret.Length);}catch(DecoderFallbackException){throw Failure("SSH_VAULT_SECRET_INVALID");}
  }

  public static byte[] Prompt(string user,string target) {return Prompt(user,target,user);}
  public static byte[] Prompt(string user,string target,string displayTarget) {
    return Prompt(user,target,displayTarget,null);
  }
  public static byte[] Prompt(string user,string target,string displayTarget,Action<string> eventSink) {
    return Prompt(user,target,displayTarget,eventSink,IntPtr.Zero);
  }
  public static byte[] Prompt(string user,string target,string displayTarget,Action<string> eventSink,IntPtr owner) {
    ValidateTarget(target);ValidateUser(user);ValidateDisplay(displayTarget);
    IntPtr empty=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,userBuffer=IntPtr.Zero,domainBuffer=IntPtr.Zero,passwordBuffer=IntPtr.Zero;
    uint inputSize=0,outputSize=0;int allocatedInput=0,userBytes=0,domainBytes=0,passwordBytes=0;
    char[] passwordChars=null;byte[] secret=null;bool returned=false;
    try {
      empty=AllocateZero(2);
      bool sized=CredPackAuthenticationBufferW(PACK_GENERIC,user,empty,IntPtr.Zero,ref inputSize);
      int error=Marshal.GetLastWin32Error();
      Require(!sized&&error==INSUFFICIENT_BUFFER&&inputSize>0&&inputSize<=MAX_AUTH_BUFFER,"SSH_VAULT_PROMPT_PACK_SIZE_FAILED");
      allocatedInput=(int)inputSize;input=AllocateZero(allocatedInput);
      if(!CredPackAuthenticationBufferW(PACK_GENERIC,user,empty,input,ref inputSize))throw NativeFailure("SSH_VAULT_PROMPT_PACK_FAILED",Marshal.GetLastWin32Error());
      Require(inputSize<=allocatedInput,"SSH_VAULT_PROMPT_PACK_SIZE_FAILED");
      CREDUI_INFO info=new CREDUI_INFO();info.Size=(uint)Marshal.SizeOf(typeof(CREDUI_INFO));
      info.Parent=owner;
      info.Caption="Project Hub — 記住 SSH 登入";
      info.Message="Linux SSH："+displayTarget+"\n帳號："+user+"\n驗證成功後，密碼將保存於此電腦的 Windows 認證管理員。\n取消會中止；不會自動再次詢問。";
      uint package=0;bool save=false;
      if(eventSink!=null)eventSink("PROMPT_REQUESTED");
      uint result=CredUIPromptForWindowsCredentialsW(ref info,0,ref package,input,inputSize,out output,out outputSize,ref save,GENERIC);
      if(eventSink!=null)eventSink(result==CANCELLED?"PROMPT_CANCELLED":"PROMPT_RETURNED");
      if(result==CANCELLED)throw Failure("SSH_VAULT_PROMPT_CANCELLED");
      if(result!=0)throw NativeFailure("SSH_VAULT_PROMPT_FAILED",unchecked((int)result));
      Require(output!=IntPtr.Zero&&outputSize>0&&outputSize<=MAX_AUTH_BUFFER,"SSH_VAULT_PROMPT_BUFFER_INVALID");
      uint userCount=0,domainCount=0,passwordCount=0;
      bool unpacked=CredUnPackAuthenticationBufferW(0,output,outputSize,IntPtr.Zero,ref userCount,IntPtr.Zero,ref domainCount,IntPtr.Zero,ref passwordCount);
      error=Marshal.GetLastWin32Error();
      Require(!unpacked&&error==INSUFFICIENT_BUFFER&&userCount>0&&userCount<=257&&domainCount<=257&&passwordCount>0&&passwordCount<=MAX_SECRET+1,"SSH_VAULT_PROMPT_UNPACK_SIZE_FAILED");
      userBytes=checked((int)userCount*2);domainBytes=checked((int)Math.Max(domainCount,1U)*2);passwordBytes=checked((int)passwordCount*2);
      userBuffer=AllocateZero(userBytes);domainBuffer=AllocateZero(domainBytes);passwordBuffer=AllocateZero(passwordBytes);
      domainCount=(uint)(domainBytes/2);
      if(!CredUnPackAuthenticationBufferW(0,output,outputSize,userBuffer,ref userCount,domainBuffer,ref domainCount,passwordBuffer,ref passwordCount))throw NativeFailure("SSH_VAULT_PROMPT_UNPACK_FAILED",Marshal.GetLastWin32Error());
      Require(String.Equals(BoundedString(userBuffer,userBytes/2-1,"SSH_VAULT_PROMPT_USER_INVALID"),user,StringComparison.Ordinal),"SSH_VAULT_PROMPT_USER_MISMATCH");
      Require(Marshal.ReadInt16(domainBuffer)==0,"SSH_VAULT_PROMPT_DOMAIN_REJECTED");
      int length=0;while(length<passwordBytes/2&&Marshal.ReadInt16(passwordBuffer,length*2)!=0)length++;
      Require(length>0&&length<passwordBytes/2,"SSH_VAULT_SECRET_INVALID");
      // No nonzero data may follow the native string terminator. The native API
      // may retain the supplied capacity in its output count.
      for(int i=length+1;i<passwordBytes/2;i++)Require(Marshal.ReadInt16(passwordBuffer,i*2)==0,"SSH_VAULT_SECRET_INVALID");
      passwordChars=new char[length];Marshal.Copy(passwordBuffer,passwordChars,0,length);
      try {secret=Utf8.GetBytes(passwordChars);}catch(EncoderFallbackException){throw Failure("SSH_VAULT_SECRET_INVALID");}
      Validate(secret);if(eventSink!=null)eventSink("PROMPT_UNPACKED");returned=true;return secret;
    } finally {
      if(!returned&&secret!=null)Array.Clear(secret,0,secret.Length);
      if(passwordChars!=null)Array.Clear(passwordChars,0,passwordChars.Length);
      ClearFree(passwordBuffer,passwordBytes);ClearFree(domainBuffer,domainBytes);ClearFree(userBuffer,userBytes);
      if(output!=IntPtr.Zero){try {if(outputSize<=Int32.MaxValue)Zero(output,(int)outputSize);}finally {Marshal.FreeCoTaskMem(output);}}
      ClearFree(input,allocatedInput);ClearFree(empty,2);
    }
  }

  public static bool Exists(string target) {
    ValidateTarget(target);IntPtr p=ReadNative(target,true);
    try {return p!=IntPtr.Zero;}finally {FreeCredential(p);}
  }
  public static byte[] Read(string target,string user) {
    ValidateTarget(target);ValidateUser(user);IntPtr p=ReadNative(target,false);byte[] secret=null;bool returned=false;
    try {
      CREDENTIAL c=Structure(p);CheckRecord(c,target,user);
      secret=new byte[(int)c.CredentialBlobSize];Marshal.Copy(c.CredentialBlob,secret,0,secret.Length);Validate(secret);
      returned=true;return secret;
    } finally {if(!returned&&secret!=null)Array.Clear(secret,0,secret.Length);FreeCredential(p);}
  }
  public static void Create(string target,string user,byte[] secret) {
    ValidateTarget(target);ValidateUser(user);Validate(secret);
    // CredWrite is not atomic create-only. The broker must retain its owner lock;
    // fresh random registration IDs avoid collisions with unrelated entries.
    Require(!Exists(target),"SSH_VAULT_ALREADY_EXISTS");
    IntPtr blob=IntPtr.Zero,name=IntPtr.Zero,userName=IntPtr.Zero,comment=IntPtr.Zero;bool written=false;
    try {
      blob=AllocateZero(secret.Length);Marshal.Copy(secret,0,blob,secret.Length);
      name=Marshal.StringToHGlobalUni(target);userName=Marshal.StringToHGlobalUni(user);comment=Marshal.StringToHGlobalUni(COMMENT);
      CREDENTIAL c=new CREDENTIAL();c.Type=GENERIC;c.TargetName=name;c.UserName=userName;c.Comment=comment;c.Persist=LOCAL_MACHINE;
      c.CredentialBlobSize=(uint)secret.Length;c.CredentialBlob=blob;
      if(!CredWriteW(ref c,0))throw NativeFailure("SSH_VAULT_WRITE_FAILED",Marshal.GetLastWin32Error());
      written=true;IntPtr readback=ReadNative(target,false);
      try {CREDENTIAL stored=Structure(readback);CheckRecord(stored,target,user);Require(EqualNative(stored,secret),"SSH_VAULT_READBACK_MISMATCH");}
      finally {FreeCredential(readback);}
    } catch {
      if(written) {
        // Never remove an entry whose exact owner metadata and bytes cannot be
        // confirmed. Failure means storage outcome unknown, not "not saved".
        bool owned=false;IntPtr proof=IntPtr.Zero;
        try {proof=ReadNative(target,false);CREDENTIAL c=Structure(proof);CheckRecord(c,target,user);owned=EqualNative(c,secret);}catch {owned=false;}finally {FreeCredential(proof);}
        if(!owned)throw Failure("SSH_VAULT_STORAGE_OUTCOME_UNKNOWN");
        try {Delete(target);}catch {throw Failure("SSH_VAULT_STORAGE_OUTCOME_UNKNOWN");}
        throw Failure("SSH_VAULT_SAVE_FAILED_ROLLED_BACK");
      }
      throw;
    } finally {
      ClearFree(blob,secret.Length);
      if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);if(userName!=IntPtr.Zero)Marshal.FreeHGlobal(userName);if(comment!=IntPtr.Zero)Marshal.FreeHGlobal(comment);
    }
  }
  public static void Delete(string target) {
    ValidateTarget(target);
    if(!CredDeleteW(target,GENERIC,0)) {int error=Marshal.GetLastWin32Error();if(error!=NOT_FOUND)throw NativeFailure("SSH_VAULT_DELETE_FAILED",error);}
    Require(!Exists(target),"SSH_VAULT_DELETE_UNCONFIRMED");
  }
}
