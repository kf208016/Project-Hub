using System;
using System.Drawing;
using System.Windows.Forms;

// This window holds no password field. Only an explicit one-shot button opens
// native CredUI, owned by this window on the same STA desktop thread.
internal sealed class HubSshEnrollmentWindow : Form {
  internal readonly Button StartButton, CancelButtonControl;
  internal byte[] Secret;
  internal Exception Failure;
  internal bool Started;
  readonly Func<IntPtr,byte[]> prompt;
  readonly Action<string> eventSink;

  internal HubSshEnrollmentWindow(string displayTarget,string user,Func<IntPtr,byte[]> prompt,Action<string> eventSink) {
    if(prompt==null)throw new ArgumentNullException("prompt");
    this.prompt=prompt;this.eventSink=eventSink;
    Text="Project Hub — SSH 連線設定";
    StartPosition=FormStartPosition.CenterScreen;FormBorderStyle=FormBorderStyle.FixedDialog;
    MaximizeBox=false;MinimizeBox=true;ShowInTaskbar=true;AutoScaleMode=AutoScaleMode.Dpi;
    Font=new Font("Microsoft JhengHei UI",10F);ClientSize=new Size(540,280);
    var heading=new Label {Text="記住 Linux SSH 登入",Location=new Point(24,22),AutoSize=true,Font=new Font(Font,FontStyle.Bold)};
    var description=new Label {Text="主機："+displayTarget+"\n帳號："+user+"\n\n按下「開始一次錄入」後，才會開啟 Windows 密碼視窗。\n驗證成功後保存於 Windows 認證管理員，供後續免提示連線。\n取消或失敗會停止，不會自動再次詢問。",Location=new Point(24,60),Size=new Size(492,155)};
    StartButton=new Button {Text="開始一次錄入",Location=new Point(256,228),Size=new Size(150,34)};
    CancelButtonControl=new Button {Text="取消",Location=new Point(418,228),Size=new Size(98,34)};
    StartButton.Click+=StartEnrollment;
    CancelButtonControl.Click+=delegate {if(!Started){DialogResult=DialogResult.Cancel;Close();}};
    CancelButton=CancelButtonControl;
    Controls.AddRange(new Control[]{heading,description,StartButton,CancelButtonControl});
    Shown+=delegate {
      try {if(this.eventSink!=null)this.eventSink("ENROLLMENT_READY");Activate();BringToFront();}
      catch(Exception e){Failure=e;DialogResult=DialogResult.Abort;Close();}
    };
  }
  void StartEnrollment(object sender,EventArgs e) {
    if(Started||Failure!=null||IsDisposed)return;
    Started=true;StartButton.Enabled=false;CancelButtonControl.Enabled=false;
    try {
      if(eventSink!=null)eventSink("ENROLLMENT_REQUESTED");
      Secret=prompt(Handle);HubSshVaultStore.Validate(Secret);
      DialogResult=DialogResult.OK;
    } catch(Exception error) {
      if(Secret!=null){Array.Clear(Secret,0,Secret.Length);Secret=null;}
      Failure=error;DialogResult=DialogResult.Abort;
    }
  }
  protected override void Dispose(bool disposing) {
    if(Secret!=null){Array.Clear(Secret,0,Secret.Length);Secret=null;}
    base.Dispose(disposing);
  }
}

public static class HubSshVaultEnrollment {
  public static byte[] Collect(string user,string target,string display,Action<string> eventSink) {
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    using(var window=new HubSshEnrollmentWindow(display,user,owner=>HubSshVaultStore.Prompt(user,target,display,eventSink,owner),eventSink)) {
      window.ShowDialog();
      if(window.Failure!=null)throw window.Failure;
      if(window.Secret==null)throw new InvalidOperationException("SSH_VAULT_ENROLLMENT_CANCELLED");
      byte[] secret=window.Secret;window.Secret=null;return secret;
    }
  }
}
