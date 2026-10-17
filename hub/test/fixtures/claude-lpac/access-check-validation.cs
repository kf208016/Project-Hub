// Pure guard/descriptor checks plus a read-only negative control on this
// executable's own primary token. No profile/child/ACL/registry/auth operations.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

static class ProbeLpacAccessSelfTest {
  const BindingFlags Static=BindingFlags.Static|BindingFlags.NonPublic;
  static int assertions;
  static void Check(bool value,string label){assertions++;if(!value)throw new Exception(label);}
  static object Call(string name,params object[] args){MethodInfo method=typeof(HubClaudeLpacProbe).GetMethod(name,Static);Check(method!=null,"fixed guard exists");return method.Invoke(null,args);}
  static Dictionary<string,object> Map(object value){return new Dictionary<string,object>((IDictionary<string,object>)value);}
  static void Rejection(string name,object[] args,string code,int native){
    bool rejected=false;
    try{Call(name,args);}catch(TargetInvocationException e){
      Type type=e.InnerException.GetType();Check(type.Name=="Rejected","fixed failure envelope");
      Check((string)type.GetField("Code").GetValue(e.InnerException)==code,"precise failure class");
      Check((int)type.GetField("Native").GetValue(e.InnerException)==native,"native error preserved");rejected=true;
    }
    Check(rejected,"unsafe observation rejected");
  }
  static object[] Observation(bool success,int error,bool status,uint granted,uint expected,uint capacity,uint returned,uint count){return new object[]{success,error,status,granted,expected,capacity,returned,count};}
  static int Main(){
    string sddl=(string)typeof(HubClaudeLpacProbe).GetField("LpacAccessSddl",Static).GetRawConstantValue();
    Check(sddl=="O:SYG:SYD:(A;;0x3;;;WD)(A;;0x1;;;S-1-15-2-1)(A;;0x2;;;S-1-15-2-2)","fixed Chromium descriptor");
    RawSecurityDescriptor sd=new RawSecurityDescriptor(sddl);
    Check(sd.Owner.Value=="S-1-5-18"&&sd.Group.Value=="S-1-5-18","owner/group are LocalSystem");
    Check(sd.DiscretionaryAcl!=null&&sd.DiscretionaryAcl.Count==3,"no null/extra ACL");
    string[] sids={"S-1-1-0","S-1-15-2-1","S-1-15-2-2"};int[] masks={3,1,2};
    for(int i=0;i<3;i++){CommonAce ace=sd.DiscretionaryAcl[i]as CommonAce;Check(ace!=null&&ace.AceQualifier==AceQualifier.AccessAllowed&&ace.AceFlags==AceFlags.None,"fixed noninherited allow ACE");Check(ace.SecurityIdentifier.Value==sids[i]&&ace.AccessMask==masks[i],"exact SID/order/mask");}
    foreach(uint expected in new uint[]{2,3}){
      Dictionary<string,object> ok=Map(Call("ValidateLpacAccess",Observation(true,87,true,expected,expected,4096,4096,0)));
      Check((uint)ok["grantedMask"]==expected&&(int)ok["nativeCode"]==0,"successful observations ignore stale LastError");
    }
    foreach(uint expected in new uint[]{0,1,4,UInt32.MaxValue})Rejection("ValidateLpacAccess",Observation(true,0,true,expected,expected,4096,4096,0),"LPAC_ACCESS_EXPECTATION_INVALID",0);
    foreach(int error in new int[]{0,5,6,87,122})Rejection("ValidateLpacAccess",Observation(false,error,true,2,2,4096,4096,0),"LPAC_ACCESS_QUERY_FAILED",error);
    Rejection("ValidateLpacAccess",Observation(true,5,false,2,2,4096,4096,0),"LPAC_ACCESS_DENIED",5);
    foreach(uint mask in new uint[]{0,1,3,4,UInt32.MaxValue})Rejection("ValidateLpacAccess",Observation(true,0,true,mask,2,4096,4096,0),"LPAC_ACCESS_MASK_MISMATCH",0);
    Rejection("ValidateLpacAccess",Observation(true,0,true,2,3,4096,4096,0),"LPAC_ACCESS_MASK_MISMATCH",0);
    foreach(uint capacity in new uint[]{0,4095,4097,UInt32.MaxValue})Rejection("ValidateLpacAccess",Observation(true,0,true,2,2,capacity,8,0),"LPAC_ACCESS_PRIVILEGE_SIZE_INVALID",0);
    foreach(uint returned in new uint[]{0,7,4097,UInt32.MaxValue})Rejection("ValidateLpacAccess",Observation(true,0,true,2,2,4096,returned,0),"LPAC_ACCESS_PRIVILEGE_SIZE_INVALID",0);
    foreach(uint count in new uint[]{1,UInt32.MaxValue})Rejection("ValidateLpacAccess",Observation(true,0,true,2,2,4096,8,count),"LPAC_ACCESS_PRIVILEGE_COUNT_INVALID",0);
    Rejection("ValidateLpacAccess",Observation(true,0,true,2,2,4096,4096,341),"LPAC_ACCESS_PRIVILEGE_COUNT_INVALID",0);
    Rejection("ValidateLpacAccess",Observation(true,0,true,2,2,4096,20,1),"LPAC_ACCESS_PRIVILEGE_COUNT_INVALID",0);
    Dictionary<string,object> unavailable=Map(Call("Class46Observation",false,87,-1,UInt32.MaxValue));
    Check((bool)unavailable["queryUnavailable"]&&(int)unavailable["nativeCode"]==87,"only fixed API error 87 unavailable");
    Check(unavailable["returnedBytes"]==null&&unavailable["value"]==null,"failed query payload/length never interpreted");
    foreach(int error in new int[]{0,5,6,122,998})Rejection("Class46Observation",new object[]{false,error,4,1u},"TOKEN_CLASS_46_QUERY_FAILED",error);
    foreach(int length in new int[]{0,1,8,65536})Rejection("Class46Observation",new object[]{true,0,length,1u},"TOKEN_CLASS_46_SIZE_INVALID",0);
    foreach(uint value in new uint[]{0,2,UInt32.MaxValue})Rejection("Class46Observation",new object[]{true,0,4,value},"TOKEN_CLASS_46_LPAC_MISMATCH",0);
    Dictionary<string,object> available=Map(Call("Class46Observation",true,87,4,1u));
    Check(!(bool)available["queryUnavailable"]&&(int)available["value"]==1&&(int)available["nativeCode"]==0,"available class46 requires exact one");
    // This is the only real OS access check in this fixture, on our own token.
    Dictionary<string,object> owner=Map(Call("LpacOwnerControl",WindowsIdentity.GetCurrent().User.Value));
    Check((uint)owner["grantedMask"]==3&&(bool)owner["accessStatus"]&&(bool)owner["functionSucceeded"],"actual current-owner negative control");
    Console.WriteLine(new JavaScriptSerializer().Serialize(new{schemaVersion=1,guardAssertions=assertions,profileCreated=false,lpacPositiveMeasured=false,target="current-process-only",ownerControl=owner}));
    return 0;
  }
}
