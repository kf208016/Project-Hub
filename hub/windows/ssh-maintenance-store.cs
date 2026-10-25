// Exact-target Windows Credential Manager access for the SSH broker.
// Caller owns the registration lock and verifies SID, descriptor, code and roots.
// Generic credentials remain accessible to other programs running as this user.
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class HubSshMaintenanceStore {
  const uint GENERIC=1, LOCAL_MACHINE=2, PACK_GENERIC=4;
  const int NOT_FOUND=1168, INSUFFICIENT_BUFFER=122, CANCELLED=1223;
  const int MAX_SECRET=2560, MAX_AUTH_BUFFER=1024*1024;
  const string PREFIX="ProjectHub.WorkerSshPassword.v1/";
  public static string Comment(string migrationId,string manifestSHA256,string binding) {return "Project Hub SSH migrated v1|"+migrationId+"|"+manifestSHA256+"|"+binding;}
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
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr credential);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredWriteW(ref CREDENTIAL credential,uint flags);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredDeleteW(string target,uint type,uint flags);
  [DllImport("advapi32.dll",ExactSpelling=true)] static extern void CredFree(IntPtr credential);
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
  static void CheckRecord(CREDENTIAL c,string target,string user,string comment) {
    Require(c.Type==GENERIC&&c.Flags==0&&c.Persist==LOCAL_MACHINE&&c.AttributeCount==0&&c.TargetAlias==IntPtr.Zero,"SSH_VAULT_METADATA_MISMATCH");
    Require(String.Equals(BoundedString(c.TargetName,32767,"SSH_VAULT_METADATA_MISMATCH"),target,StringComparison.Ordinal),"SSH_VAULT_METADATA_MISMATCH");
    Require(String.Equals(BoundedString(c.UserName,256,"SSH_VAULT_METADATA_MISMATCH"),user,StringComparison.Ordinal),"SSH_VAULT_USER_MISMATCH");
    Require(String.Equals(BoundedString(c.Comment,256,"SSH_VAULT_METADATA_MISMATCH"),comment,StringComparison.Ordinal),"SSH_VAULT_METADATA_MISMATCH");
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

  public static bool Exists(string target) {
    ValidateTarget(target);IntPtr p=ReadNative(target,true);
    try {return p!=IntPtr.Zero;}finally {FreeCredential(p);}
  }
  public static byte[] Read(string target,string user,string comment) {
    ValidateTarget(target);ValidateUser(user);IntPtr p=ReadNative(target,false);byte[] secret=null;bool returned=false;
    try {
      CREDENTIAL c=Structure(p);CheckRecord(c,target,user,comment);
      secret=new byte[(int)c.CredentialBlobSize];Marshal.Copy(c.CredentialBlob,secret,0,secret.Length);Validate(secret);
      returned=true;return secret;
    } finally {if(!returned&&secret!=null)Array.Clear(secret,0,secret.Length);FreeCredential(p);}
  }
  public static void Create(string target,string user,byte[] secret,string expectedComment) {
    ValidateTarget(target);ValidateUser(user);Validate(secret);
    // CredWrite is not atomic create-only. The broker must retain its owner lock;
    // fresh random registration IDs avoid collisions with unrelated entries.
    Require(!Exists(target),"SSH_VAULT_ALREADY_EXISTS");
    IntPtr blob=IntPtr.Zero,name=IntPtr.Zero,userName=IntPtr.Zero,comment=IntPtr.Zero;
    try {
      blob=AllocateZero(secret.Length);Marshal.Copy(secret,0,blob,secret.Length);
      name=Marshal.StringToHGlobalUni(target);userName=Marshal.StringToHGlobalUni(user);comment=Marshal.StringToHGlobalUni(expectedComment);
      CREDENTIAL c=new CREDENTIAL();c.Type=GENERIC;c.TargetName=name;c.UserName=userName;c.Comment=comment;c.Persist=LOCAL_MACHINE;
      c.CredentialBlobSize=(uint)secret.Length;c.CredentialBlob=blob;
      if(!CredWriteW(ref c,0))throw NativeFailure("SSH_VAULT_WRITE_FAILED",Marshal.GetLastWin32Error());
      IntPtr readback=ReadNative(target,false);
      try {CREDENTIAL stored=Structure(readback);CheckRecord(stored,target,user,expectedComment);Require(EqualNative(stored,secret),"SSH_VAULT_READBACK_MISMATCH");}
      finally {FreeCredential(readback);}
    } finally {
      ClearFree(blob,secret.Length);
      if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);if(userName!=IntPtr.Zero)Marshal.FreeHGlobal(userName);if(comment!=IntPtr.Zero)Marshal.FreeHGlobal(comment);
    }
  }
  public static bool Equal(byte[] a,byte[] b){if(a.Length!=b.Length)return false;int d=0;for(int i=0;i<a.Length;i++)d|=a[i]^b[i];return d==0;}
  public static void Delete(string target,string user,byte[] secret,string comment) {
    ValidateTarget(target);byte[] actual=Read(target,user,comment);try{Require(Equal(actual,secret),"DESTINATION_CONTENT_CHANGED");}finally{Array.Clear(actual,0,actual.Length);}
    if(!CredDeleteW(target,GENERIC,0)) {int error=Marshal.GetLastWin32Error();if(error!=NOT_FOUND)throw NativeFailure("SSH_VAULT_DELETE_FAILED",error);}
    Require(!Exists(target),"SSH_VAULT_DELETE_UNCONFIRMED");
  }
}
