// Local process/pipe fixture. No network, CredUI, Credential Manager, or real SSH.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;

class HubVaultTransportFixture {
  const string Pin="SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  static readonly byte[] Synthetic=Encoding.UTF8.GetBytes("  fixture-繁體-🔒-end  ");
  static string Self {get{return Assembly.GetExecutingAssembly().Location;}}
  static string Quote(string value){return "\""+value.Replace("\"","\\\"")+"\"";}
  static int Child(string arguments,bool wrongNonce,bool verify) {
    ProcessStartInfo start=new ProcessStartInfo(Self,arguments);start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
    if(wrongNonce)start.EnvironmentVariables["HUB_SSH_VAULT_NONCE"]=new string('0',64);
    using(Process child=Process.Start(start)){
      MemoryStream data=new MemoryStream();child.StandardOutput.BaseStream.CopyTo(data);child.WaitForExit();
      if(!verify)return child.ExitCode;
      byte[] bytes=data.ToArray();int difference=bytes.Length^(Synthetic.Length+1);
      if(difference==0){for(int i=0;i<Synthetic.Length;i++)difference|=bytes[i]^Synthetic[i];difference|=bytes[bytes.Length-1]^10;}
      Array.Clear(bytes,0,bytes.Length);return child.ExitCode==0&&difference==0?0:124;
    }
  }
  static int Main(string[] args) {
    if(args.Length>0&&args[0]=="--middle"){
      int depth=Int32.Parse(args[1]);return Child(depth>0?"--middle "+(depth-1):"askpass",false,false);
    }
    if(args.Length>0&&args[0]=="--fixture-ssh"){
      string scenario=args[1];Console.Error.WriteLine("debug1: Server host key: ssh-ed25519 "+Pin);Console.Error.Flush();
      if(scenario=="timeout"){System.Threading.Thread.Sleep(30000);return 99;}
      int code=Child(scenario=="ancestry"?"--middle 5":"askpass",scenario=="nonce",scenario!="ancestry");
      if(code!=0)return code;
      if(scenario=="replay"&&Child("askpass",false,false)!=125)return 98;
      Console.Error.WriteLine("Authenticated to fixture.invalid ([127.0.0.1]:22) using \"password\".");
      Console.Error.WriteLine("sensitive-untrusted-debug-must-not-escape");Console.Error.Flush();
      Console.Write("IDENTITY_OK\n");Console.Out.Flush();return 0;
    }
    if(Environment.GetEnvironmentVariable("HUB_SSH_VAULT_PIPE")!=null)return HubSshVaultTransport.Askpass();
    string mode=args.Length==0?"success":args[0];List<string> events=new List<string>();
    HubSshVaultTransport.Options options=new HubSshVaultTransport.Options();options.Ssh=Self;options.Helper=Self;options.Args=new string[]{"--fixture-ssh",mode};options.Cwd=Path.GetDirectoryName(Self);options.Secret=Synthetic;options.CaptureOutput=true;options.DeadlineMs=mode=="timeout"?1500:15000;options.HostFingerprint=Pin;
    options.EventSink=delegate(string value){lock(events)events.Add(value);};
    try{
      HubSshVaultTransport.Result result=HubSshVaultTransport.Run(options);
      Console.WriteLine(new JavaScriptSerializer().Serialize(new{result.ExitCode,result.Authenticated,result.AskpassSupplied,result.CleanupVerified,Output=Encoding.UTF8.GetString(result.Output),Events=events}));
      return 0;
    }catch(Exception error){Console.WriteLine(new JavaScriptSerializer().Serialize(new{Error=error.GetType().Name,Code=error.Message}));return 125;}
    finally{Array.Clear(Synthetic,0,Synthetic.Length);}
  }
}
