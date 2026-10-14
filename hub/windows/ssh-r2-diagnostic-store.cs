// Read-only exact-target Credential Manager access. No write/delete/enumerate/UI imports.
using System;
using System.Runtime.InteropServices;
using C=HubSshMaintenanceCommon;
public static class HubSshR2DiagnosticStore {
  [StructLayout(LayoutKind.Sequential)] struct FT {public uint Low,High;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Credential {
    public uint Flags,Type;public IntPtr TargetName,Comment;public FT LastWritten;
    public uint CredentialBlobSize;public IntPtr CredentialBlob;public uint Persist,AttributeCount;
    public IntPtr Attributes,TargetAlias,UserName;
  }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr credential);
  [DllImport("advapi32.dll",ExactSpelling=true)] static extern void CredFree(IntPtr credential);
  static string Text(IntPtr p,int maximum){C.Require(p!=IntPtr.Zero,"DIAGNOSTIC_CREDENTIAL_METADATA");for(int n=0;n<=maximum;n++)if(Marshal.ReadInt16(p,n*2)==0)return Marshal.PtrToStringUni(p,n);throw new InvalidOperationException("DIAGNOSTIC_CREDENTIAL_METADATA");}
  public static byte[] Read(string target,string user,string comment){
    C.Require(System.Text.RegularExpressions.Regex.IsMatch(target??"","^ProjectHub\\.WorkerSshPassword\\.v1/[a-f0-9-]{36}/[a-f0-9]{64}$"),"DIAGNOSTIC_CREDENTIAL_TARGET");
    IntPtr p=IntPtr.Zero;byte[] secret=null;bool returned=false;
    try{if(!CredReadW(target,1,0,out p))throw new InvalidOperationException(Marshal.GetLastWin32Error()==1168?"DIAGNOSTIC_CREDENTIAL_MISSING":"DIAGNOSTIC_CREDENTIAL_READ_FAILED");var c=(Credential)Marshal.PtrToStructure(p,typeof(Credential));C.Require(c.Flags==0&&c.Type==1&&c.Persist==2&&c.AttributeCount==0&&c.TargetAlias==IntPtr.Zero&&Text(c.TargetName,180)==target&&Text(c.UserName,256)==user&&Text(c.Comment,256)==comment,"DIAGNOSTIC_CREDENTIAL_METADATA");C.Require(c.CredentialBlob!=IntPtr.Zero&&c.CredentialBlobSize>0&&c.CredentialBlobSize<=2560,"DIAGNOSTIC_CREDENTIAL_SECRET");secret=new byte[(int)c.CredentialBlobSize];Marshal.Copy(c.CredentialBlob,secret,0,secret.Length);foreach(byte b in secret)C.Require(b!=0&&b!=10&&b!=13,"DIAGNOSTIC_CREDENTIAL_SECRET");C.Utf8.GetCharCount(secret);returned=true;return secret;}
    finally{if(!returned&&secret!=null)Array.Clear(secret,0,secret.Length);if(p!=IntPtr.Zero){try{var c=(Credential)Marshal.PtrToStructure(p,typeof(Credential));if(c.CredentialBlob!=IntPtr.Zero&&c.CredentialBlobSize<=2560)for(int i=0;i<(int)c.CredentialBlobSize;i++)Marshal.WriteByte(c.CredentialBlob,i,0);}finally{CredFree(p);}}}
  }
}
