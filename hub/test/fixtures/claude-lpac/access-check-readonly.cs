// Test-only behavioral observation, never a replacement for controller class 46.
// Chromium CheckLpacToken reference: commit
// 5c210565c3fa181730df37778d22af487a0d5e40,
// sandbox/win/src/app_container_test.cc (source SHA-256 in evidence manifest).
// Opens only its own current-process token; duplicates it for AccessCheck.
// No profile, file ACL, impersonation, CLI, claims or other-process token APIs.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Web.Script.Serialization;

static class ProbeAccessCheckReadOnly {
  const int PrivilegeCapacity=4096;
  [StructLayout(LayoutKind.Sequential)] struct GenericMapping {public uint Read,Write,Execute,All;}
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int capacity,out int returned);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int level,int type,out IntPtr duplicate);
  [DllImport("advapi32.dll")] static extern bool IsValidSecurityDescriptor(IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(IntPtr descriptor,IntPtr client,uint desired,ref GenericMapping mapping,IntPtr privileges,ref uint privilegeBytes,out uint granted,out bool status);
  sealed class Rejected:Exception {public readonly string Code;public readonly int Native;public Rejected(string code,int native){Code=code;Native=native;}}
  static void Need(bool value,string code,int native){if(!value)throw new Rejected(code,native);}
  static int Main(string[] args){
    var result=new SortedDictionary<string,object>(StringComparer.Ordinal);
    result["schemaVersion"]=1;result["target"]="current-process-only";result["tokenAccess"]=10;
    result["isAppContainer"]=null;result["functionSucceeded"]=null;result["nativeError"]=0;
    result["accessStatus"]=null;result["grantedMask"]=null;result["privilegeSetCapacity"]=PrivilegeCapacity;
    result["privilegeSetReturnedBytes"]=null;result["code"]="NOT_MEASURED";
    IntPtr token=IntPtr.Zero,duplicate=IntPtr.Zero,scalar=IntPtr.Zero,descriptor=IntPtr.Zero,privileges=IntPtr.Zero;int exit=1;
    try{
      Need(args.Length==0,"ARGUMENT_REJECTED",0);
      bool success=OpenProcessToken(GetCurrentProcess(),10,out token);int error=Marshal.GetLastWin32Error();
      Need(success&&token!=IntPtr.Zero,"OWN_TOKEN_OPEN_FAILED",success?0:error);
      scalar=Marshal.AllocHGlobal(4);int returned;
      success=GetTokenInformation(token,29,scalar,4,out returned);error=Marshal.GetLastWin32Error();
      Need(success,"APP_CONTAINER_QUERY_FAILED",error);Need(returned==4,"APP_CONTAINER_SIZE_INVALID",0);
      result["isAppContainer"]=Marshal.ReadInt32(scalar)!=0;
      // SecurityIdentification (1), TokenImpersonation (2), TOKEN_QUERY (8).
      // The token is passed to AccessCheck only; the calling thread is unchanged.
      success=DuplicateTokenEx(token,8,IntPtr.Zero,1,2,out duplicate);error=Marshal.GetLastWin32Error();
      Need(success&&duplicate!=IntPtr.Zero,"OWN_TOKEN_DUPLICATE_FAILED",success?0:error);
      var sd=new RawSecurityDescriptor("O:SYG:SYD:(A;;0x3;;;WD)(A;;0x1;;;S-1-15-2-1)(A;;0x2;;;S-1-15-2-2)");
      byte[] binary=new byte[sd.BinaryLength];sd.GetBinaryForm(binary,0);
      descriptor=Marshal.AllocHGlobal(binary.Length);Marshal.Copy(binary,0,descriptor,binary.Length);
      Need(IsValidSecurityDescriptor(descriptor),"MEMORY_DESCRIPTOR_INVALID",0);
      privileges=Marshal.AllocHGlobal(PrivilegeCapacity);Marshal.Copy(new byte[PrivilegeCapacity],0,privileges,PrivilegeCapacity);
      uint privilegeBytes=PrivilegeCapacity,granted;bool accessStatus;GenericMapping mapping=new GenericMapping();
      SetLastError(0);
      success=AccessCheck(descriptor,duplicate,0x02000000,ref mapping,privileges,ref privilegeBytes,out granted,out accessStatus);
      error=Marshal.GetLastWin32Error();
      result["functionSucceeded"]=success;result["nativeError"]=error;
      result["privilegeSetReturnedBytes"]=success||error==122?(object)privilegeBytes:null;
      if(success){
        Need(privilegeBytes>=8&&privilegeBytes<=PrivilegeCapacity,"PRIVILEGE_SET_SIZE_INVALID",0);
        uint count=unchecked((uint)Marshal.ReadInt32(privileges));
        Need(count<=(privilegeBytes-8)/12,"PRIVILEGE_SET_COUNT_INVALID",0);
        result["accessStatus"]=accessStatus;result["grantedMask"]=granted;
      }
      // An API failure is an observed failure, never an LPAC/non-LPAC result.
      // Output fields documented as undefined on failure stay null.
      result["code"]="ACCESSCHECK_OBSERVED";exit=0;
    }catch(Rejected e){result["code"]=e.Code;result["nativeError"]=e.Native;}
    catch{result["code"]="DIAGNOSTIC_INTERNAL_FAILURE";result["nativeError"]=0;}
    finally{
      foreach(IntPtr buffer in new IntPtr[]{scalar,descriptor,privileges})if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);
      bool closed=true;int closeError=0;
      if(duplicate!=IntPtr.Zero&&!CloseHandle(duplicate)){closeError=Marshal.GetLastWin32Error();closed=false;}
      if(token!=IntPtr.Zero&&!CloseHandle(token)){int error=Marshal.GetLastWin32Error();if(closed)closeError=error;closed=false;}
      if(!closed){result["code"]="OWN_TOKEN_CLOSE_UNKNOWN";result["nativeError"]=closeError;exit=1;}
    }
    Console.WriteLine(new JavaScriptSerializer().Serialize(result));return exit;
  }
}
